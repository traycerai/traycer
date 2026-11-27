/**
 * `useTabStripController` is the strip's behaviour without its layout, so a
 * presentation other than the header strip can mount over it. This suite pins:
 *
 *  - the `tab.split.*` and `epic.close` keybinding handlers are registered
 *    exactly once each under the real header `TabStrip` and released on
 *    unmount (`side-tab-strip.test.tsx` counts the same over the side strip),
 *    so a presentation that registered any of these ids itself would read two
 *    live registrations;
 *  - `isEmptyLanding`, read through a trivial list presentation, is true only
 *    with no tabs on route `/` (Home drawn is `tab-strip-home-placement`'s);
 *  - the dialogs are handed back as a node for the presentation to place.
 */
import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useTabStripController } from "@/components/layout/tabs/tab-strip-controller";
import { TabStrip } from "@/components/layout/tabs/tab-strip";
import { TabContextMenuContent } from "@/components/layout/tabs/tab-strip-context-menu";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { TaskPinnedState } from "@/hooks/epic/use-epic-task-pinned-states-query";
import { useComputerTaskPinReading } from "@/hooks/epic/use-epic-task-pinned-states-query";
import type { ActionId } from "@/lib/keybindings/actions";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useTabsStore } from "@/stores/tabs/store";
import { tabItemId } from "@/stores/tabs/layout";
import type { HeaderTab, TabRef } from "@/stores/tabs/types";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { installTabSyncCoordinator } from "@/lib/tab-sync/tab-sync-coordinator";
import { useAuthStore } from "@/stores/auth/auth-store";
import * as sessions from "@/lib/registries/epic-session-registry";
import * as routing from "@traycer-clients/shared/host-client/host-rpc-routing";
import {
  localEntry,
  personalRemoteEntry,
  poolEntry,
  teamSandboxEntry,
} from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { readHostServingDecision } from "@/lib/host/serving-decision";
import { useServingPeerHostId } from "@/lib/host/serving-decision";
import { HostDirectoryService } from "@/lib/host/host-directory-service";
import { HostRuntimeContext } from "@/lib/host/runtime";
import { HostRuntime } from "@traycer-clients/shared/host-client/host-runtime";
import { AuthService } from "@/lib/auth/auth-service";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import {
  mountTestSelectionAuthority,
  type SelectionAuthorityFixture,
} from "@/lib/host/test-support/selection-authority-fixture";
import { handleHostIds } from "@/lib/registries/epic-session-registry";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  cloudEpicTasksQueryKey,
  LIST_CLOUD_TASKS_REQUEST,
} from "@/lib/cloud-epic-tasks-query/query";
import {
  computerPinAcknowledgementAt11,
  directHistoryGrant,
  poolListedTaskAt16,
  poolPinAcknowledgementAt11,
  settledPoolPageAt16,
  taskContextsAt14,
  type TaskContextScenarioAt14,
} from "@/lib/history-composition/test-support/history-wire-fixtures";

const pinBinding = vi.hoisted(
  (): {
    current: {
      hostClient: HostClient<HostRpcRegistry>;
      directory: HostDirectoryService;
    } | null;
  } => ({ current: null }),
);
const runtimeBinding = vi.hoisted(
  (): { current: HostRuntimeBinding<HostRpcRegistry> | null } => ({
    current: null,
  }),
);

/** Live registrations per action id, and the most ever live at once. */
const registrations = vi.hoisted(
  (): {
    readonly live: Map<string, number>;
    readonly peak: Map<string, number>;
  } => ({ live: new Map(), peak: new Map() }),
);

// Partial: the registry itself stays real; the wrapper only counts how many
// registrations of each id are live at the same time.
vi.mock("@/lib/keybindings/dispatch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/keybindings/dispatch")>();
  return {
    ...actual,
    registerDynamicActionHandler: (
      id: ActionId,
      handler: () => void,
    ): (() => void) => {
      const live = (registrations.live.get(id) ?? 0) + 1;
      registrations.live.set(id, live);
      registrations.peak.set(
        id,
        Math.max(live, registrations.peak.get(id) ?? 0),
      );
      const unregister = actual.registerDynamicActionHandler(id, handler);
      return () => {
        registrations.live.set(id, (registrations.live.get(id) ?? 1) - 1);
        unregister();
      };
    },
  };
});

vi.mock("@/hooks/notifications/use-host-notification-indicators-query", () => ({
  useHostNotificationIndicators: () => ({
    data: { epics: {}, chats: {} },
    isPending: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
  }),
}));

vi.mock(
  "@/hooks/epic/use-epic-task-pinned-states-query",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/epic/use-epic-task-pinned-states-query")
      >();
    return {
      ...actual,
      useEpicTaskPinnedStates: () => new Map<string, TaskPinnedState>(),
    };
  },
);

// The router-only layout cases need only the active id. The pin cases install
// a real requester and exercise the normal mutation and transport dispatch.
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () =>
      pinBinding.current?.hostClient ?? {
        getActiveHostId: () => localEntry.hostId,
      },
    useHostBinding: () => pinBinding.current,
  };
});

installTabSyncCoordinator({ readyPromise: Promise.resolve() });

const KEYBINDING_IDS: ReadonlyArray<ActionId> = [
  "tab.split.add",
  "tab.split.swap",
  "tab.split.separate",
  "tab.split.close-left",
  "tab.split.close-right",
  "epic.close",
];

let queryClient: QueryClient;

/** A second presentation: a plain list over the controller, nothing else. */
function ListPresentation(): ReactNode {
  const controller = useTabStripController();
  return (
    <ul
      data-testid="list-presentation"
      data-empty-landing={String(controller.isEmptyLanding)}
      data-dialogs-returned={String(isValidElement(controller.dialogs))}
    >
      {controller.headerItemIds.map((itemId) => (
        <li key={itemId}>{itemId}</li>
      ))}
    </ul>
  );
}

function buildRouter(initialPath: string, presentation: ReactNode) {
  const rootRoute = createRootRoute({
    component: () => {
      const content = (
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>{presentation}</TooltipProvider>
        </QueryClientProvider>
      );
      return runtimeBinding.current === null ? (
        content
      ) : (
        <HostRuntimeContext.Provider value={runtimeBinding.current}>
          {content}
        </HostRuntimeContext.Provider>
      );
    },
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const elsewhereRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/elsewhere",
    component: () => null,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, elsewhereRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

function setHomeTabEnabled(enabled: boolean): void {
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  useLayoutStore
    .getState()
    .setRegionValues("homeTab", { shown: enabled ? "shown" : "hidden" });
}

function resetStores(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useTabsStore.setState(useTabsStore.getInitialState(), true);
}

function openEpicTab(id: string): void {
  useEpicCanvasStore.getState().seedEpic(id, { tabId: id, name: id }, []);
  const ref: TabRef = { kind: "epic", id };
  useTabsStore.setState({
    version: 2,
    items: [{ kind: "tab", id: tabItemId(ref), ref }],
    activeItemId: tabItemId(ref),
    stripOrder: [ref],
    systemTabs: { history: null, settings: null },
  });
}

const inertTaskStreamFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

class PoolMenuRunnerHost extends MockRunnerHost {
  override readonly poolBaseUrl = poolEntry.websocketUrl ?? "";
}

function registerPoolTaskSession(epicId: string): void {
  registerTaskSession(epicId, POOL_HOST_ID);
}

function registerTaskSession(epicId: string, hostId: string): void {
  const handle = openStoreForTest({
    epicId,
    userId: "synthetic-tab-viewer",
    factories: {
      streamClientFactory: inertTaskStreamFactory,
      laneSelection: null,
    },
    writeCommand: null,
  });
  handleHostIds.set(handle, hostId);
  sessions.__getOpenEpicRegistryForTests().acquire(epicId, () => handle);
}

function PoolTaskMenuPresentation(props: {
  readonly epicId: string;
  readonly existingReading?: TaskPinnedState | null;
}): ReactNode {
  const controller = useTabStripController();
  const tab = controller.tabs.find(
    (candidate): candidate is Extract<HeaderTab, { kind: "epic" }> =>
      candidate.kind === "epic" && candidate.epicId === props.epicId,
  );
  if (tab === undefined) return null;

  const taskPinnedState =
    props.existingReading === undefined
      ? (controller.taskPinnedStates.get(props.epicId) ?? null)
      : props.existingReading;
  return (
    <ContextMenu>
      <ContextMenuTrigger>Open task menu</ContextMenuTrigger>
      <TabContextMenuContent
        tab={tab}
        canClose
        canCloseOtherTabs={controller.canCloseOtherTabs}
        canOpenInNewWindow={controller.canOpenInNewWindow}
        canEditTitle={false}
        taskPinnedState={taskPinnedState}
        isTaskPinPending={controller.pendingSetPinnedEpicIds.has(props.epicId)}
        onClose={controller.onClose}
        onCloseOtherTabs={controller.onCloseOtherTabs}
        onDuplicateTab={controller.onDuplicateTab}
        onOpenInNewWindow={controller.onOpenInNewWindow}
        onSplitCommand={controller.onSplitCommand}
        onEditTitle={() => undefined}
        onSetTaskPinned={(pinned) =>
          controller.onSetTaskPinned(props.epicId, pinned, tab.name, null)
        }
        onSetAddressedTaskPinned={(pinned, reading) =>
          controller.onSetTaskPinned(props.epicId, pinned, tab.name, reading)
        }
      />
    </ContextMenu>
  );
}

function ComputerContextTaskMenuPresentation(props: {
  readonly epicId: string;
}): ReactNode {
  const servingHostId = useServingPeerHostId();
  const reading = useComputerTaskPinReading(
    props.epicId,
    servingHostId === null || servingHostId === POOL_HOST_ID
      ? localEntry.hostId
      : servingHostId,
    null,
  );
  return (
    <PoolTaskMenuPresentation epicId={props.epicId} existingReading={reading} />
  );
}

async function selectPoolMenuPeers(
  windowPeer: "pool" | "personal" | "team",
  taskPeer: "pool" | "personal" | "team" | null,
  includeLocalSelection: boolean,
) {
  const peerFor = (peer: "personal" | "team") =>
    peer === "personal" ? personalRemoteEntry : teamSandboxEntry;
  const windowComputer = windowPeer === "pool" ? null : peerFor(windowPeer);
  const localProcessEntry =
    windowPeer === "team" ? teamSandboxEntry : localEntry;
  const localHostId = windowPeer === "team" ? teamSandboxEntry.hostId : null;
  const selectionLocalHostId = includeLocalSelection
    ? localEntry.hostId
    : localHostId;
  const taskComputer =
    taskPeer === null || taskPeer === "pool" ? null : peerFor(taskPeer);
  const remoteEntries = [windowComputer, taskComputer]
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .filter(
      (entry, index, all) =>
        all.findIndex((candidate) => candidate.hostId === entry.hostId) ===
        index,
    );
  const selectionEntries = [
    ...remoteEntries,
    ...(includeLocalSelection ? [localEntry] : []),
  ];
  const selection = mountTestSelectionAuthority({
    hosts: selectionEntries.map((entry) => ({
      hostId: entry.hostId,
      kind:
        entry.hostId === selectionLocalHostId
          ? ("local" as const)
          : ("remote" as const),
      teamOwned: entry.hostId === teamSandboxEntry.hostId,
    })),
    localHostId: selectionLocalHostId,
    readyComputers: [
      ...(windowComputer === null ? [] : [windowComputer.hostId]),
      ...(includeLocalSelection ? [localEntry.hostId] : []),
    ],
    pool: "ready",
  });
  const windowSelection =
    windowComputer === null
      ? selection.openPool()
      : await selection.activate(windowComputer.hostId).then((result) => {
          expect(result).toEqual({ ok: true });
          return selection.snapshot();
        });
  expect(windowSelection.servingPeer).toMatchObject(
    windowComputer === null
      ? { kind: "pool" }
      : { kind: "computer", hostId: windowComputer.hostId },
  );
  return { selection, localProcessEntry, remoteEntries, taskComputer };
}

function recordPoolMenuManifests(
  remoteHostIds: readonly string[],
  includeLocalSelection: boolean,
): void {
  recordNegotiatedHostManifest(POOL_HOST_ID, {
    "epic.listTasks": { major: 1, minor: 6 },
    "epic.setPinned": { major: 1, minor: 1 },
  });
  for (const hostId of remoteHostIds) {
    const manifest = {
      "epic.getTaskContexts": { major: 1, minor: 4 },
      "epic.setPinned": { major: 1, minor: 1 },
      ...(hostId === teamSandboxEntry.hostId
        ? {}
        : { "epic.listTasks": { major: 1, minor: 6 } }),
    };
    recordNegotiatedHostManifest(hostId, manifest);
  }
  if (includeLocalSelection) {
    recordNegotiatedHostManifest(localEntry.hostId, {
      "epic.getTaskContexts": { major: 1, minor: 4 },
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.setPinned": { major: 1, minor: 1 },
    });
  }
}

async function mountPoolOnlyTaskMenu(options: {
  readonly epicId: string;
  readonly listed: boolean;
  readonly livePoolSession: boolean;
  readonly windowPeer?: "pool" | "personal" | "team";
  readonly taskPeer?: "pool" | "personal" | "team" | null;
  readonly poolPinned?: boolean;
  readonly computerPinned?: boolean;
  readonly seedStalePoolPage?: boolean;
  readonly includeLocalSelection?: boolean;
}): Promise<{
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
  readonly selection: SelectionAuthorityFixture;
}> {
  const {
    epicId,
    listed,
    livePoolSession,
    windowPeer = "pool",
    taskPeer = livePoolSession ? "pool" : null,
    poolPinned = false,
    computerPinned = false,
    seedStalePoolPage = false,
    includeLocalSelection = false,
  } = options;
  const userId = "synthetic-tab-viewer";
  const { selection, localProcessEntry, remoteEntries, taskComputer } =
    await selectPoolMenuPeers(windowPeer, taskPeer, includeLocalSelection);
  const plan = routing.createHostRpcTierPlan(poolEntry);
  vi.spyOn(routing, "readProcessHostRpcTierPlan").mockReturnValue(plan);
  useAuthStore.getState().setSignedIn(
    {
      userId,
      userName: "Tab viewer",
      email: "viewer@example.invalid",
    },
    { userId, username: "Tab viewer" },
    [],
  );
  const messenger = new MockHostMessenger({
    registry: hostRpcRegistry,
    requestId: () => "pool-tab-menu-request",
    handlers: {
      "epic.listTasks": () =>
        settledPoolPageAt16(
          listed
            ? [
                poolListedTaskAt16({
                  id: epicId,
                  title: "Pool task",
                  grant: directHistoryGrant("owner", userId),
                  pinned: poolPinned,
                  updatedAt: 10,
                }),
              ]
            : [],
          { hasMore: false, nextCursor: undefined },
          userId,
        ),
      "epic.getTaskContexts": ({ taskIds }) =>
        taskContextsAt14(
          taskIds,
          taskIds.map((taskId): TaskContextScenarioAt14 =>
            taskPeer === "team"
              ? {
                  kind: "local-home-found",
                  taskId,
                  title: "Team local task",
                  userId,
                  recentAt: 10,
                  pinned: computerPinned,
                }
              : {
                  kind: "cloud-found",
                  taskId,
                  title: "Computer context task",
                  grant: directHistoryGrant("owner", userId),
                  recentAt: 10,
                  pinned: computerPinned,
                },
          ),
        ),
      "epic.setPinned": ({ pinned }) =>
        taskPeer === "pool"
          ? poolPinAcknowledgementAt11(pinned)
          : computerPinAcknowledgementAt11(
              pinned,
              taskPeer === "team" ? "local" : "cloud",
            ),
    },
  });
  const findHostById = (hostId: string) =>
    [localProcessEntry, poolEntry, ...remoteEntries].find(
      (entry) => entry.hostId === hostId,
    ) ?? null;
  const { version, websocketUrl } = localProcessEntry;
  if (version === null || websocketUrl === null)
    throw new Error("The pool menu fixture needs a dialable local host");
  const runnerHost = new PoolMenuRunnerHost({
    signInUrl: "https://auth.example.invalid/sign-in",
    authnBaseUrl: "https://auth.example.invalid",
    localHost: {
      hostId: localProcessEntry.hostId,
      websocketUrl,
      version,
      pid: 1,
      systemHostName: "Synthetic local computer",
      displayName: "Synthetic local computer",
      availability: "available",
    },
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: true,
    traycerCli: undefined,
  });
  const auth = new AuthService({ runnerHost });
  const directory = new HostDirectoryService({
    runnerHost,
    remoteFetcher: () =>
      Promise.resolve({ kind: "hosts", entries: remoteEntries }),
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
    selectedHostId: () => selection.snapshot().effectiveHostId,
    servingDecision: () => readHostServingDecision(findHostById),
  });
  runtime.start();
  const binding: HostRuntimeBinding<HostRpcRegistry> = {
    runtime,
    hostClient: runtime.hostClient,
    directory,
    auth,
    hostId: null,
  };
  binding.hostClient.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "synthetic-tab-bearer",
      identity: {
        userId,
        username: "Tab viewer",
        providerHandle: userId,
      },
    }),
  );
  runtimeBinding.current = binding;
  pinBinding.current = {
    hostClient: binding.hostClient,
    directory,
  };
  recordPoolMenuManifests(
    remoteEntries.map(({ hostId }) => hostId),
    includeLocalSelection,
  );
  if (seedStalePoolPage) {
    queryClient.setQueryData(
      cloudEpicTasksQueryKey(POOL_HOST_ID, userId, LIST_CLOUD_TASKS_REQUEST),
      settledPoolPageAt16(
        [
          poolListedTaskAt16({
            id: epicId,
            title: "Pool task",
            grant: directHistoryGrant("owner", userId),
            pinned: !computerPinned,
            updatedAt: 10,
          }),
        ],
        { hasMore: false, nextCursor: undefined },
        userId,
      ),
    );
  }
  openEpicTab(epicId);
  if (taskPeer === "pool") registerPoolTaskSession(epicId);
  else if (taskComputer !== null)
    registerTaskSession(epicId, taskComputer.hostId);
  else if (livePoolSession) registerPoolTaskSession(epicId);
  render(
    <RouterProvider
      router={buildRouter(
        "/elsewhere",
        windowPeer === "personal" ? (
          <ComputerContextTaskMenuPresentation epicId={epicId} />
        ) : (
          <PoolTaskMenuPresentation epicId={epicId} />
        ),
      )}
    />,
  );
  return { messenger, selection };
}

async function renderAt(path: string): Promise<HTMLElement> {
  render(<RouterProvider router={buildRouter(path, <ListPresentation />)} />);
  return screen.findByTestId("list-presentation");
}

describe("useTabStripController", () => {
  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    registrations.live.clear();
    registrations.peak.clear();
    setHomeTabEnabled(false);
    resetStores();
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
    sessions.__getOpenEpicRegistryForTests().disposeAll();
    resetNegotiatedManifests();
    setHomeTabEnabled(false);
    resetStores();
    if (runtimeBinding.current !== null) {
      runtimeBinding.current.runtime.dispose();
      runtimeBinding.current.directory.dispose();
      runtimeBinding.current.auth.dispose();
      runtimeBinding.current = null;
    } else {
      pinBinding.current?.hostClient.dispose();
      pinBinding.current?.directory.dispose();
    }
    pinBinding.current = null;
    vi.restoreAllMocks();
    useAuthStore.setState({ status: "signed-out" });
  });

  it.each([true, false])(
    "uses the open task's peer for a cloud pin when pool configured is %s",
    async (configured) => {
      const epicId = "e-a";
      const taskPeer = configured ? poolEntry : personalRemoteEntry;
      const selection = mountTestSelectionAuthority({
        hosts: [
          { hostId: localEntry.hostId, kind: "local", teamOwned: false },
          {
            hostId: personalRemoteEntry.hostId,
            kind: "remote",
            teamOwned: false,
          },
        ],
        localHostId: localEntry.hostId,
        readyComputers: [localEntry.hostId, personalRemoteEntry.hostId],
        pool: configured ? "ready" : "disabled",
      });
      expect(await selection.activate(localEntry.hostId)).toEqual({ ok: true });
      expect(selection.snapshot().servingPeer).toEqual({
        kind: "computer",
        hostId: localEntry.hostId,
      });
      const plan = routing.createHostRpcTierPlan(configured ? poolEntry : null);
      vi.spyOn(routing, "readProcessHostRpcTierPlan").mockReturnValue(plan);
      vi.spyOn(sessions, "getEpicSessionHostId").mockReturnValue(
        taskPeer.hostId,
      );
      useAuthStore.getState().setSignedIn(
        {
          userId: "synthetic-tab-viewer",
          userName: "Tab viewer",
          email: "viewer@example.invalid",
        },
        { userId: "synthetic-tab-viewer", username: "Tab viewer" },
        [],
      );
      const messenger = new MockHostMessenger({
        registry: hostRpcRegistry,
        requestId: () => "synthetic-tab-pin",
        handlers: {
          "epic.setPinned": ({ pinned }) =>
            taskPeer.hostId === poolEntry.hostId
              ? poolPinAcknowledgementAt11(pinned)
              : computerPinAcknowledgementAt11(pinned, "cloud"),
        },
      });
      const findHostById = (id: string) =>
        [localEntry, taskPeer].find((entry) => entry.hostId === id) ?? null;
      const client = new HostClient({
        registry: hostRpcRegistry,
        schedulingPolicy: hostRpcSchedulingPolicy,
        invalidator: createHostQueryInvalidator(queryClient),
        findHostById,
        messenger,
        routing: {
          plan,
          selectedHostId: () => selection.snapshot().effectiveHostId,
          serving: () => readHostServingDecision(findHostById),
        },
      });
      client.setRequestContext(
        createRequestContextFixture({
          origin: "renderer",
          bearerToken: "synthetic-tab-bearer",
          identity: {
            userId: "synthetic-tab-viewer",
            username: "Tab viewer",
            providerHandle: "synthetic-tab-viewer",
          },
        }),
      );
      const { version, websocketUrl } = localEntry;
      if (version === null || websocketUrl === null)
        throw new Error("The local pin fixture must be dialable");
      const directory = new HostDirectoryService({
        runnerHost: new MockRunnerHost({
          signInUrl: "https://auth.example.invalid/sign-in",
          authnBaseUrl: "https://auth.example.invalid",
          localHost: {
            hostId: localEntry.hostId,
            websocketUrl,
            version,
            pid: 1,
            systemHostName: "Synthetic local computer",
            displayName: "Synthetic local computer",
            availability: "available",
          },
          hosts: [],
          workspaceFolderPickerPaths: undefined,
          hasLocalHost: true,
          traycerCli: undefined,
        }),
        remoteFetcher: () => Promise.resolve({ kind: "hosts", entries: [] }),
        onRegistryPollTick: null,
        authContextId: null,
        credentialGeneration: null,
        localHostIdSeeder: null,
      });
      await directory.start();
      pinBinding.current = {
        hostClient: client.createRequesterForHostId(localEntry.hostId),
        directory,
      };
      openEpicTab(epicId);
      const taskPinReading: TaskPinnedState = {
        pinned: false,
        home: undefined,
        hostId: configured ? taskPeer.hostId : null,
        pinnedKnown: configured,
      };
      function PinControl(): ReactNode {
        const controller = useTabStripController();
        return (
          <button
            type="button"
            onClick={() =>
              controller.onSetTaskPinned(
                epicId,
                true,
                "Synthetic open task",
                configured ? taskPinReading : null,
              )
            }
          >
            Pin task
          </button>
        );
      }
      render(
        <RouterProvider router={buildRouter("/elsewhere", <PinControl />)} />,
      );
      fireEvent.click(await screen.findByRole("button", { name: "Pin task" }));
      await waitFor(() =>
        expect(
          messenger.calls
            .filter((call) => call.method === "epic.setPinned")
            .map((call) => ({
              hostId: call.authority.endpoint.hostId,
              params: call.params,
            })),
        ).toEqual([
          {
            hostId: configured ? taskPeer.hostId : localEntry.hostId,
            params: { epicId, pinned: true },
          },
        ]),
      );
    },
  );

  it.each([
    { windowPeer: "pool" as const, label: "pool window" },
    { windowPeer: "team" as const, label: "team-computer window" },
  ])(
    "pins a pool task from the real menu using the pool account list for a $label",
    async ({ windowPeer }) => {
      const epicId = `pool-open-menu-task-${windowPeer}`;
      const { messenger } = await mountPoolOnlyTaskMenu({
        epicId,
        listed: true,
        livePoolSession: true,
        windowPeer,
        taskPeer: "pool",
      });
      fireEvent.contextMenu(await screen.findByText("Open task menu"));
      const pageKey = cloudEpicTasksQueryKey(
        POOL_HOST_ID,
        "synthetic-tab-viewer",
        LIST_CLOUD_TASKS_REQUEST,
      );
      await waitFor(() => {
        expect(queryClient.getQueryData(pageKey)).toMatchObject({
          tasks: [{ epic: { light: { id: epicId } }, pinned: false }],
        });
      });
      expect(
        messenger.calls.find((call) => call.method === "epic.listTasks"),
      ).toMatchObject({ authority: { endpoint: { hostId: POOL_HOST_ID } } });

      const pin = await screen.findByTestId(`tab-pin-history-${epicId}`);
      expect(pin.getAttribute("aria-disabled")).toBeNull();
      expect(pin.getAttribute("data-disabled")).toBeNull();
      fireEvent.click(pin);

      await waitFor(() => {
        expect(
          messenger.calls.filter((call) => call.method === "epic.setPinned"),
        ).toHaveLength(1);
      });
      expect(
        messenger.calls.find((call) => call.method === "epic.setPinned"),
      ).toMatchObject({
        authority: { endpoint: { hostId: POOL_HOST_ID } },
        params: { epicId, pinned: true },
      });
    },
  );

  it.each([
    {
      windowPeer: "pool" as const,
      taskPeer: "personal" as const,
      label: "a pool window with a personal-computer task",
      readHostId: personalRemoteEntry.hostId,
      writeHostId: personalRemoteEntry.hostId,
    },
    {
      windowPeer: "personal" as const,
      taskPeer: "personal" as const,
      label: "a personal-computer window with its own task",
      readHostId: personalRemoteEntry.hostId,
      writeHostId: personalRemoteEntry.hostId,
    },
  ])(
    "uses the computer context and task session for $label",
    async ({ windowPeer, taskPeer, readHostId, writeHostId }) => {
      const epicId = `computer-open-menu-${windowPeer}-${taskPeer}`;
      const { messenger } = await mountPoolOnlyTaskMenu({
        epicId,
        listed: false,
        livePoolSession: false,
        windowPeer,
        taskPeer,
        computerPinned: false,
      });
      fireEvent.contextMenu(await screen.findByText("Open task menu"));
      const pin = await screen.findByTestId(`tab-pin-history-${epicId}`);
      await waitFor(() => {
        expect(
          messenger.calls.some(
            (call) =>
              call.method === "epic.getTaskContexts" &&
              call.authority.endpoint.hostId === readHostId,
          ),
        ).toBe(true);
      });
      expect(pin.textContent).toBe("Pin Task in History");
      fireEvent.click(pin);

      await waitFor(() => {
        expect(
          messenger.calls.filter((call) => call.method === "epic.setPinned"),
        ).toHaveLength(1);
      });
      expect(
        messenger.calls.find((call) => call.method === "epic.setPinned"),
      ).toMatchObject({
        authority: { endpoint: { hostId: writeHostId } },
        params: { epicId, pinned: true },
      });
      expect(
        messenger.calls.filter((call) => call.method === "epic.listTasks"),
      ).toEqual([]);
    },
  );

  it("uses the personal task computer pin for Unpin in a team window when the pool answers the account list", async () => {
    const epicId = "team-window-personal-task-pin";
    const { messenger } = await mountPoolOnlyTaskMenu({
      epicId,
      listed: true,
      livePoolSession: true,
      windowPeer: "team",
      taskPeer: "personal",
      poolPinned: false,
      computerPinned: true,
    });
    fireEvent.contextMenu(await screen.findByText("Open task menu"));
    const pin = await screen.findByTestId(`tab-pin-history-${epicId}`);

    await waitFor(() => {
      expect(
        messenger.calls.some(
          (call) =>
            call.method === "epic.getTaskContexts" &&
            call.authority.endpoint.hostId === personalRemoteEntry.hostId,
        ),
      ).toBe(true);
    });
    expect(pin.textContent).toBe("Unpin Task in History");
    fireEvent.click(pin);

    await waitFor(() => {
      expect(
        messenger.calls.filter((call) => call.method === "epic.setPinned"),
      ).toHaveLength(1);
    });
    expect(
      messenger.calls.find((call) => call.method === "epic.setPinned"),
    ).toMatchObject({
      authority: { endpoint: { hostId: personalRemoteEntry.hostId } },
      params: { epicId, pinned: false },
    });
  });

  it("uses the personal account page context for a pool task and keeps the acknowledged bit over a stale computer reread", async () => {
    const epicId = "personal-window-pool-task";
    const { messenger } = await mountPoolOnlyTaskMenu({
      epicId,
      listed: true,
      livePoolSession: true,
      windowPeer: "personal",
      taskPeer: "pool",
      computerPinned: false,
      seedStalePoolPage: true,
    });
    fireEvent.contextMenu(await screen.findByText("Open task menu"));
    const pin = await screen.findByTestId(`tab-pin-history-${epicId}`);
    await waitFor(() => {
      expect(
        messenger.calls.some(
          (call) =>
            call.method === "epic.getTaskContexts" &&
            call.authority.endpoint.hostId === personalRemoteEntry.hostId,
        ),
      ).toBe(true);
    });
    expect(pin.textContent).toBe("Pin Task in History");
    expect(
      messenger.calls.filter((call) => call.method === "epic.listTasks"),
    ).toEqual([]);

    fireEvent.click(pin);
    await waitFor(() => {
      expect(
        messenger.calls.filter((call) => call.method === "epic.setPinned"),
      ).toHaveLength(1);
      expect(
        messenger.calls.filter(
          (call) => call.method === "epic.getTaskContexts",
        ),
      ).toHaveLength(2);
    });
    expect(
      messenger.calls.find((call) => call.method === "epic.setPinned"),
    ).toMatchObject({
      authority: { endpoint: { hostId: POOL_HOST_ID } },
      params: { epicId, pinned: true },
    });

    fireEvent.contextMenu(await screen.findByText("Open task menu"));
    const reopenedPin = await screen.findByTestId(`tab-pin-history-${epicId}`);
    expect(reopenedPin.textContent).toBe("Unpin Task in History");
  });

  it("re-reads the computer context when the window is re-pointed with the task menu open", async () => {
    const epicId = "personal-window-repointed-pool-task";
    const { messenger, selection } = await mountPoolOnlyTaskMenu({
      epicId,
      listed: true,
      livePoolSession: true,
      windowPeer: "personal",
      taskPeer: "pool",
      computerPinned: false,
      includeLocalSelection: true,
    });

    fireEvent.contextMenu(await screen.findByText("Open task menu"));
    const pin = await screen.findByTestId(`tab-pin-history-${epicId}`);
    await waitFor(() => {
      expect(
        messenger.calls.some(
          (call) =>
            call.method === "epic.getTaskContexts" &&
            call.authority.endpoint.hostId === personalRemoteEntry.hostId,
        ),
      ).toBe(true);
    });
    expect(pin.textContent).toBe("Pin Task in History");
    expect(
      messenger.calls.filter((call) => call.method === "epic.listTasks"),
    ).toEqual([]);

    expect(await selection.activate(localEntry.hostId)).toEqual({ ok: true });
    await waitFor(() => {
      expect(
        messenger.calls.some(
          (call) =>
            call.method === "epic.getTaskContexts" &&
            call.authority.endpoint.hostId === localEntry.hostId,
        ),
      ).toBe(true);
      expect(pin.textContent).toBe("Pin Task in History");
    });

    fireEvent.click(pin);
    await waitFor(() => {
      expect(
        messenger.calls.filter((call) => call.method === "epic.setPinned"),
      ).toHaveLength(1);
    });
    expect(
      messenger.calls.find((call) => call.method === "epic.setPinned"),
    ).toMatchObject({
      authority: { endpoint: { hostId: POOL_HOST_ID } },
      params: { epicId, pinned: true },
    });
  });

  it.each([
    {
      listed: false,
      livePoolSession: true,
      label: "without pool pin evidence",
    },
    {
      listed: true,
      livePoolSession: false,
      label: "without a task session handle",
    },
  ])("keeps Pin disabled $label", async ({ listed, livePoolSession }) => {
    const epicId = `pool-open-menu-${listed}-${livePoolSession}`;
    const { messenger } = await mountPoolOnlyTaskMenu({
      epicId,
      listed,
      livePoolSession,
    });
    fireEvent.contextMenu(await screen.findByText("Open task menu"));
    const pin = await screen.findByTestId(`tab-pin-history-${epicId}`);
    await waitFor(() => {
      expect(
        pin.getAttribute("aria-disabled") === "true" ||
          pin.getAttribute("data-disabled") !== null,
      ).toBe(true);
    });
    fireEvent.click(pin);
    expect(
      messenger.calls.filter((call) => call.method === "epic.setPinned"),
    ).toEqual([]);
    if (listed) {
      expect(
        messenger.calls.filter((call) => call.method === "epic.listTasks"),
      ).toEqual([]);
    } else {
      await waitFor(() => {
        expect(
          queryClient.getQueryData(
            cloudEpicTasksQueryKey(
              POOL_HOST_ID,
              "synthetic-tab-viewer",
              LIST_CLOUD_TASKS_REQUEST,
            ),
          ),
        ).toMatchObject({ tasks: [] });
      });
    }
  });

  it("keeps one live registration per id under the real header strip", async () => {
    openEpicTab("e-a");
    render(<RouterProvider router={buildRouter("/elsewhere", <TabStrip />)} />);
    await screen.findByTestId("tab-strip");

    for (const id of KEYBINDING_IDS) {
      expect(registrations.live.get(id)).toBe(1);
      expect(registrations.peak.get(id)).toBe(1);
    }

    cleanup();

    for (const id of KEYBINDING_IDS) {
      expect(registrations.live.get(id)).toBe(0);
    }
  });

  it("reports an empty landing only with Home off, no tabs and route /", async () => {
    const list = await renderAt("/");
    expect(list.getAttribute("data-empty-landing")).toBe("true");
  });

  it("is not an empty landing with a tab open", async () => {
    openEpicTab("e-a");
    const list = await renderAt("/");
    expect(list.getAttribute("data-empty-landing")).toBe("false");
  });

  it("is not an empty landing off the landing route", async () => {
    const list = await renderAt("/elsewhere");
    expect(list.getAttribute("data-empty-landing")).toBe("false");
  });

  it("returns the dialogs as a node for the presentation to place", async () => {
    const list = await renderAt("/elsewhere");
    expect(list.getAttribute("data-dialogs-returned")).toBe("true");
  });
});
