import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { TestRouterProvider } from "@/__tests__/with-test-router";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { ChatDeadTileBannerContainer } from "@/components/epic-canvas/renderers/chat-tile";
import type { ChatDeadTileBannerReason } from "@/components/epic-canvas/renderers/dead-tile-banner";
import { TestEpicSessionWrapper } from "@/components/epic-canvas/__tests__/test-epic-session";
import {
  createEpicSessionTestHarness,
  type TestEpicHarness,
} from "@/components/epic-canvas/__tests__/test-epic-session-harness";
import type { TaskSandboxHost } from "@/hooks/epic/use-task-sandbox-end";
import type { SandboxConfigurations } from "@/hooks/sandboxes/use-sandbox-configurations";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { recordNegotiatedHostMethods } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { CollaboratorEntry } from "@traycer/protocol/host/epic/unary-schemas";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import {
  __getOpenEpicRegistryForTests,
  EpicSessionHostClientContext,
} from "@/lib/registries/epic-session-registry";
import type { EnvironmentListResponse } from "@traycer/protocol/host/environment/contracts";
import type { ChatContinueHereResponse } from "@traycer/protocol/host/chat-serving/index";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";
import {
  installHostConnectionRegistrySource,
  resetHostConnectionRegistryForTest,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import {
  poolEntry,
  remoteEntry,
  sandboxFacts,
} from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import {
  hasActiveTestSelectionAuthority,
  mountTestSelectionAuthority,
  type SelectionAuthorityFixture,
} from "@/lib/host/test-support/selection-authority-fixture";
import {
  assertPoolTaskLanes,
  COMPLETE_TEST_LANE_MANIFEST,
  installPoolTaskTransportSpy,
  poolStateLaneSnapshot,
  poolStatusLaneSnapshot,
  type PoolTaskTransportSpy,
} from "@/lib/registries/test-support/epic-session-pool-test-support";
import { getEpicSessionController } from "@/lib/registries/epic-session-controller";
import {
  __setEpicRuntimeWorkerFactoryForTests,
  getEpicRuntimeWorkerFactoryOverride,
} from "@/lib/registries/epic-runtime-worker-factory-slot";

/**
 * THE OWNERSHIP WIRING, against the REAL container.
 *
 * The banner unit tests inject `ownedByViewer` directly and
 * the published tile's suite stubs this container, so before this file a
 * regression in the container's own resolution - the auth-store identity
 * read, the owner comparison, the fail-open default - would
 * leave every touched suite green. Here the real
 * `ChatDeadTileBannerContainer` resolves everything itself: the source owner
 * from the epic doc's chat record (the same local tier
 * `useCloneSourceOwnerUserId` consults first) and the viewer from the auth
 * store.
 *
 * The host-hook mock set mirrors `bounded-loading-catalog.test.tsx`, which
 * already mounts this container the same way: the clone offer's host-runtime
 * and mutation edges are severed, everything the file is about stays real.
 */

const MOCK_HOST_CLIENT = {
  createRequesterForHostId: (hostId: string) => ({
    ...MOCK_HOST_CLIENT,
    getActiveHostId: () => hostId,
    getActiveHost: () => MOCK_HOST_DIRECTORY.findById(hostId),
  }),
  request: (method: string, params: unknown) => {
    cloneTargetState.continueRequest(method, params);
    return Promise.resolve(cloneTargetState.continueResponse);
  },
  getActiveHost: () => null,
  getActiveHostId: () => "host-test",
  getRequestContextUserId: () => "user-test",
  getRequestContext: () => ({ userId: "user-test" }),
  onChange: () => () => undefined,
};
const MOCK_HOST_DIRECTORY = {
  onChange: () => ({ dispose() {} }),
  findById: (hostId: string) => (hostId === POOL_HOST_ID ? poolEntry : null),
};
const WINDOW_COMPUTER = {
  hostId: "host-test",
  kind: "remote",
  teamOwned: false,
} as const;
const cloneTargetState = vi.hoisted(() => ({
  client: null as {
    getActiveHost: () => null;
    getActiveHostId: () => string;
  } | null,
  hasBinding: false,
  cloneAttempt: vi.fn(),
  continueRequest: vi.fn<(method: string, params: unknown) => void>(),
  continueResponse: {
    kind: "accepted",
    operationId: "00000000-0000-4000-8000-000000000001",
    ownerHostId: "team-host",
  } as ChatContinueHereResponse,
  openTile: vi.fn<(intent: TileOpenIntent) => null>(),
  toast: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: cloneTargetState.toast }));
vi.mock("@/lib/host/use-durable-stream-transport", async (importOriginal) => {
  const { fakeDurableStreamTransports } =
    await import("@/lib/host/test-support/fake-durable-stream-transport");
  return {
    ...(await importOriginal<
      typeof import("@/lib/host/use-durable-stream-transport")
    >()),
    useDurableStreamTransportFactory: () =>
      fakeDurableStreamTransports().opener,
  };
});

// What tells a team sandbox's chat from a collaborator's: whether the build has
// a server pool, and what the team environment list answers. The list query is
// stubbed at its own seam; the ownership hook, the owner host's directory row
// and the banner copy stay real.
const environments = vi.hoisted(
  (): { pool: boolean; list: EnvironmentListResponse | undefined } => ({
    pool: false,
    list: undefined,
  }),
);

vi.mock(
  "@traycer-clients/shared/host-client/host-rpc-routing",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/host-rpc-routing")
      >();
    return {
      ...actual,
      readProcessHostRpcTierPlan: () =>
        environments.pool
          ? actual.createHostRpcTierPlan(poolEntry)
          : actual.NO_POOL_HOST_RPC_TIER_PLAN,
    };
  },
);

vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({ data: environments.list }),
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () =>
    cloneTargetState.hasBinding
      ? { directory: MOCK_HOST_DIRECTORY, hostClient: MOCK_HOST_CLIENT }
      : null,
  useOptionalHostClient: () => null,
  useHostDirectory: () => MOCK_HOST_DIRECTORY,
  useAuthService: () => ({
    revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
  }),
  useHostClient: () => MOCK_HOST_CLIENT,
  useHostRuntimeClient: () => MOCK_HOST_CLIENT,
}));

vi.mock("@/hooks/epic/use-epic-chat-mutations", async (importActual) => ({
  ...(await importActual<
    typeof import("@/hooks/epic/use-epic-chat-mutations")
  >()),
  useEpicCreateChatForHost: () => ({ mutate: vi.fn(), isPending: false }),
  useEpicCreateChatForHostClient: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null ? null : cloneTargetState.client,
}));

vi.mock("@/hooks/host/use-host-stream-client-for", async (importActual) => ({
  ...(await importActual<
    typeof import("@/hooks/host/use-host-stream-client-for")
  >()),
  useHostStreamClientFor: () => null,
  useHostStreamClientBindingFor: () => null,
}));

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
  useStreamMethodSupport: () => null,
  useStreamMethodSchemaVersion: () => null,
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-test",
}));

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: cloneTargetState.openTile }),
}));

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => vi.fn(),
}));

// The directory the clone target is named from; empty unless a case seeds it.
const directoryList = vi.hoisted((): { rows: HostDirectoryEntry[] } => ({
  rows: [],
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => {
  const useHostDirectoryList = () => ({
    data: directoryList.rows,
    fetchStatus: "success",
  });
  return {
    useHostDirectoryList,
    useHostDirectoryListQuery: useHostDirectoryList,
  };
});

vi.mock("@/lib/commands/actions/clone-chat-on-host-switch", () => ({
  cloneChatOnHostSwitch: (...args: unknown[]) => {
    cloneTargetState.cloneAttempt(...args);
    return () => undefined;
  },
}));

// The container runs the real sandbox-state hook. Its external reads are
// controlled here so the tests can exercise both answered and offline hosts;
// by default the task names no sandbox.
const sandboxHookSources = vi.hoisted(
  (): {
    task: TaskSandboxHost;
    sandboxes: SandboxSummary[];
    configurations: SandboxConfigurations;
    hostEntry: HostDirectoryEntry | null;
    sampledNow: number;
  } => ({
    task: { kind: "other" },
    sandboxes: [],
    configurations: {
      configurations: [{ kind: "personal" }],
      teamEnvironmentIds: new Set<string>(),
      complete: true,
      personalEnvironmentId: null,
    },
    hostEntry: null,
    sampledNow: 0,
  }),
);

vi.mock("@/hooks/epic/use-task-sandbox-end", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/epic/use-task-sandbox-end")>();
  return {
    ...actual,
    useTaskSandboxHost: () => sandboxHookSources.task,
  };
});

vi.mock("@/hooks/sandboxes/use-sandbox-list-query", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/sandboxes/use-sandbox-list-query")
    >();
  return {
    ...actual,
    useSandboxList: () => ({
      data: { sandboxes: sandboxHookSources.sandboxes },
    }),
  };
});

vi.mock(
  "@/hooks/sandboxes/use-sandbox-configurations",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/sandboxes/use-sandbox-configurations")
      >();
    return {
      ...actual,
      useSandboxConfigurations: () => sandboxHookSources.configurations,
    };
  },
);

vi.mock("@/hooks/host/use-host-directory-entry", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/host/use-host-directory-entry")
    >();
  return {
    ...actual,
    useHostDirectoryEntry: () => sandboxHookSources.hostEntry,
  };
});

vi.mock("@/lib/relative-time", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/relative-time")>();
  return {
    ...actual,
    useSampledNow: () => sandboxHookSources.sampledNow,
  };
});

vi.mock("@/components/report-issue/report-issue-action", () => ({
  ReportIssueAction: () => null,
}));

const CHAT_ID = "chat-owned";
const VIEWER_USER_ID = "viewer-user";
const COLLABORATOR_USER_ID = "collaborator-user";

/** A doc chat record carrying `userId` - the local tier the container's
 *  owner lookup consults before any cloud row. */
function seedChatOwnedBy(ownerUserId: string): (doc: Y.Doc) => void {
  return (doc) => {
    const epic = doc.getMap("epic");
    const chats = new Y.Map<unknown>();
    const chat = new Y.Map<unknown>();
    chat.set("id", CHAT_ID);
    chat.set("title", "Owned chat");
    chat.set("parentId", null);
    chat.set("createdAt", 0);
    chat.set("updatedAt", 0);
    chat.set("userId", ownerUserId);
    chat.set("messages", new Y.Array<unknown>());
    chats.set(CHAT_ID, chat);
    epic.set("title", "Ownership epic");
    epic.set("artifacts", new Y.Map<unknown>());
    epic.set("chats", chats);
  };
}

// One epic id (and harness) PER TEST: the session registry retains the most
// recent session per epic id across acquires, so a second
// test reusing the id can be handed the previous test's session - whose
// snapshot generation has moved on - and its installed role never lands.
// Distinct ids make every test's session its own.
let epicSeq = 0;
let activeHarness: TestEpicHarness | null = null;
let taskOnPool: {
  readonly epicId: string;
  readonly transport: PoolTaskTransportSpy;
} | null = null;
// The Epic session's client, answering `epic.listCollaborators` with
// `collaboratorEntries`; absent unless a case installs it.
let collaboratorClient: HostClient<HostRpcRegistry> | null = null;
let collaboratorEntries: CollaboratorEntry[] = [];

/** Installs a REAL client over a recording messenger as the session's. */
function installCollaboratorClient(queryClient: QueryClient): void {
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-1",
    handlers: {
      "epic.listCollaborators": () => ({
        collaborators: collaboratorEntries,
        collaboratorsAvailable: true,
      }),
    },
  });
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === "host-test" ? remoteEntry("host-test", null) : null,
    messenger,
  });
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  recordNegotiatedHostMethods("host-test", ["epic.listCollaborators"]);
  collaboratorClient = client;
}

function renderContainer(input: {
  readonly ownerUserId: string;
  /**
   * The owner the mounting surface carries, mirroring the real foreign
   * mounts: the published tile threads its ref's `ownerUserId` and the
   * canvas substitution threads the fallback ref's. A collaborator's chat
   * has no other local source - the epic projection filters out records
   * that are not visible to the signed-in user, so the container's local
   * tier can never resolve a foreign owner from the doc. The own-chat case
   * passes `undefined` and exercises exactly that local tier.
   */
  readonly providedOwnerUserId: string | undefined;
  readonly showsPublishedCopy: boolean;
  readonly reason: ChatDeadTileBannerReason;
}) {
  if (!hasActiveTestSelectionAuthority()) {
    mountTestSelectionAuthority({
      hosts: [WINDOW_COMPUTER],
      readyComputers: [WINDOW_COMPUTER.hostId],
      pool: "disabled",
    });
  }
  const epicId = `epic-banner-container-${++epicSeq}`;
  const servesFromPool =
    useSelectionAuthorityStore.getState().servingPeer?.kind === "pool";
  if (servesFromPool) {
    const previousWorker = getEpicRuntimeWorkerFactoryOverride();
    taskOnPool = {
      epicId,
      transport: installPoolTaskTransportSpy(COMPLETE_TEST_LANE_MANIFEST),
    };
    onTestFinished(() => __setEpicRuntimeWorkerFactoryForTests(previousWorker));
  } else {
    activeHarness = createEpicSessionTestHarness(epicId);
    activeHarness.install(seedChatOwnedBy(input.ownerUserId), "editor");
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  if (collaboratorEntries.length > 0) installCollaboratorClient(queryClient);
  return render(
    <TestRouterProvider>
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider
          runnerHost={
            new MockRunnerHost({
              signInUrl: "https://example.com",
              authnBaseUrl: "https://auth.example.com",
              localHost: null,
              hosts: [],
              workspaceFolderPickerPaths: undefined,
              hasLocalHost: undefined,
              traycerCli: undefined,
            })
          }
        >
          <TestEpicSessionWrapper epicId={epicId}>
            <EpicSessionHostClientContext
              value={
                collaboratorClient?.createRequesterForHostId("host-test") ??
                null
              }
            >
              <ChatDeadTileBannerContainer
                epicId={epicId}
                tabId="tab-1"
                chatId={CHAT_ID}
                sourceHostId="owner-host-1"
                hostLabel="owner-host-1"
                reason={input.reason}
                showsPublishedCopy={input.showsPublishedCopy}
                testId="banner-under-test"
                sourceOwnerUserId={
                  servesFromPool
                    ? (input.providedOwnerUserId ?? input.ownerUserId)
                    : input.providedOwnerUserId
                }
              />
            </EpicSessionHostClientContext>
          </TestEpicSessionWrapper>
        </RunnerHostProvider>
      </QueryClientProvider>
    </TestRouterProvider>,
  );
}

/** The harness delivers its snapshot on a `setTimeout(0)`; flush it so the
 *  epic store holds the seeded chat and the installed role. */
async function settleEpicSession(): Promise<void> {
  if (taskOnPool !== null) {
    await publishBannerTask(taskOnPool, POOL_HOST_ID, 0);
    expect(screen.getByTestId("banner-under-test")).toBeTruthy();
    return;
  }
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
  });
}

async function publishBannerTask(
  task: NonNullable<typeof taskOnPool>,
  hostId: string,
  workerIndex: number,
): Promise<void> {
  await waitFor(() => {
    expect(task.transport.sessions[workerIndex]?.status).toBeTruthy();
    expect(task.transport.sessions[workerIndex]?.state).toBeTruthy();
  });
  const session = task.transport.sessions[workerIndex];
  assertPoolTaskLanes(session, "expected complete task lanes for the banner");
  const epoch = `banner-task-${workerIndex}`;
  act(() => {
    session.status.onConnectionStatus("open", null, null, null);
    session.state.onConnectionStatus("open", null, null, null);
    session.status.onSnapshot(
      { ...poolStatusLaneSnapshot(epoch), permissionRole: "editor" },
      true,
    );
    session.state.onSnapshot(poolStateLaneSnapshot(epoch, "Ownership epic"));
  });
  await waitFor(() =>
    expect(
      getEpicSessionController().readTabSnapshot(task.epicId, task.epicId)
        .sessionHostId,
    ).toBe(hostId),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  useAuthStore.setState({
    status: "signed-in",
    profile: {
      userId: VIEWER_USER_ID,
      userName: "Viewer",
      email: "viewer@example.com",
    },
    contextMetadata: { userId: VIEWER_USER_ID, username: "Viewer" },
  });
  cloneTargetState.client = null;
  cloneTargetState.hasBinding = false;
  cloneTargetState.cloneAttempt.mockReset();
  cloneTargetState.continueRequest.mockReset();
  cloneTargetState.continueResponse = {
    kind: "accepted",
    operationId: "00000000-0000-4000-8000-000000000001",
    ownerHostId: "team-host",
  };
  cloneTargetState.openTile.mockReset();
  cloneTargetState.toast.mockReset();
  useSelectionAuthorityStore.getState().reset();
});

afterEach(() => {
  cleanup();
  useSelectionAuthorityStore.getState().reset();
  activeHarness?.teardown();
  activeHarness = null;
  taskOnPool = null;
  __getOpenEpicRegistryForTests().disposeAll();
  environments.pool = false;
  environments.list = undefined;
  sandboxHookSources.task = { kind: "other" };
  sandboxHookSources.sandboxes = [];
  sandboxHookSources.configurations = {
    configurations: [{ kind: "personal" }],
    teamEnvironmentIds: new Set<string>(),
    complete: true,
    personalEnvironmentId: null,
  };
  sandboxHookSources.hostEntry = null;
  sandboxHookSources.sampledNow = 0;
  directoryList.rows = [];
  collaboratorClient?.dispose();
  collaboratorClient = null;
  collaboratorEntries = [];
  resetHostConnectionRegistryForTest();
});

describe("ChatDeadTileBannerContainer - clone target availability", () => {
  it("disables and ignores Clone while the pool has no usable computer target", async () => {
    mountTestSelectionAuthority({
      hosts: [WINDOW_COMPUTER],
      savedPick: WINDOW_COMPUTER.hostId,
    });
    const user = userEvent.setup();
    renderContainer({
      ownerUserId: VIEWER_USER_ID,
      providedOwnerUserId: undefined,
      showsPublishedCopy: false,
      reason: "host-offline",
    });
    await settleEpicSession();

    const clone = await screen.findByRole("button", { name: "Clone agent" });
    expect(clone.hasAttribute("disabled")).toBe(true);
    await user.click(clone);
    expect(cloneTargetState.cloneAttempt).not.toHaveBeenCalled();
  });

  it("keeps Clone enabled and starts it on the serving computer", async () => {
    mountTestSelectionAuthority({
      hosts: [WINDOW_COMPUTER],
      readyComputers: [WINDOW_COMPUTER.hostId],
    });
    cloneTargetState.client = MOCK_HOST_CLIENT;
    cloneTargetState.hasBinding = true;
    const user = userEvent.setup();
    renderContainer({
      ownerUserId: VIEWER_USER_ID,
      providedOwnerUserId: undefined,
      showsPublishedCopy: false,
      reason: "host-offline",
    });
    await settleEpicSession();

    const clone = await screen.findByRole("button", { name: "Clone agent" });
    expect(clone.hasAttribute("disabled")).toBe(false);
    await user.click(clone);
    expect(cloneTargetState.cloneAttempt).toHaveBeenCalledTimes(1);
    expect(cloneTargetState.cloneAttempt.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ targetHostId: "host-test" }),
    );
  });
});

describe("ChatDeadTileBannerContainer - pooled team Continue action", () => {
  function offerTeamContinuation(
    response: ChatContinueHereResponse,
  ): SelectionAuthorityFixture {
    environments.pool = true;
    environments.list = {
      environments: [
        {
          environmentId: "team-env",
          ownerKind: "organization",
          ownerId: "team-1",
          roomId: "room-team",
          label: "Team",
        },
      ],
    };
    directoryList.rows = [
      remoteEntry("team-host", {
        ...sandboxFacts("team-1"),
        state: "awake",
      }),
    ];
    cloneTargetState.client = MOCK_HOST_CLIENT;
    cloneTargetState.hasBinding = true;
    cloneTargetState.continueResponse = response;
    sandboxHookSources.configurations = {
      configurations: [{ kind: "personal" }],
      teamEnvironmentIds: new Set(["team-env"]),
      complete: true,
      personalEnvironmentId: null,
    };
    const authority = mountTestSelectionAuthority({
      hosts: [
        WINDOW_COMPUTER,
        { hostId: "team-host", kind: "remote", teamOwned: true },
      ],
      readyComputers: [WINDOW_COMPUTER.hostId, "team-host"],
    });
    authority.goCold(WINDOW_COMPUTER.hostId);
    authority.connectComputer(WINDOW_COMPUTER.hostId);
    return authority;
  }

  function expectReturnDamping(authority: SelectionAuthorityFixture): void {
    const snapshot = authority.snapshot();
    expect(snapshot).toMatchObject({
      servingPeer: { kind: "pool" },
      effectiveHostId: WINDOW_COMPUTER.hostId,
    });
    expect(
      snapshot.leases.find(({ hostId }) => hostId === WINDOW_COMPUTER.hostId)
        ?.status,
    ).toBe("ready");
  }

  it("continues a pooled read-only chat from its real banner button onto the team's ready sandbox", async () => {
    const authority = offerTeamContinuation({
      kind: "accepted",
      operationId: "00000000-0000-4000-8000-000000000001",
      ownerHostId: "team-host",
    });
    const user = userEvent.setup();
    renderContainer({
      ownerUserId: "team-env",
      providedOwnerUserId: "team-env",
      showsPublishedCopy: true,
      reason: "host-offline",
    });
    await settleEpicSession();
    expectReturnDamping(authority);

    await user.click(
      await screen.findByRole("button", {
        name: "Continue on label-team-host",
      }),
    );

    await waitFor(() => {
      expect(cloneTargetState.continueRequest).toHaveBeenCalledWith(
        "chat.continueHere",
        expect.objectContaining({ chatId: CHAT_ID }),
      );
      expect(cloneTargetState.openTile).toHaveBeenCalledTimes(1);
    });
    const [intent] = cloneTargetState.openTile.mock.calls[0];
    expect(intent.node).toMatchObject({
      id: CHAT_ID,
      type: "chat",
      hostId: "team-host",
    });
    expect(intent).not.toHaveProperty("draft");
    expect(cloneTargetState.cloneAttempt).not.toHaveBeenCalled();

    const task = taskOnPool;
    if (task === null) throw new Error("expected a published pool task");
    act(() => {
      authority.finishReturnDamping();
    });
    await publishBannerTask(task, WINDOW_COMPUTER.hostId, 1);
    expect(
      screen.getByRole("button", { name: "Continue on label-team-host" }),
    ).toBeTruthy();
  });

  it("does not open another tab when the pooled Continue action is refused because its source is still live", async () => {
    const authority = offerTeamContinuation({
      kind: "refused",
      reason: "source-live",
      ownerHostId: null,
    });
    const user = userEvent.setup();
    renderContainer({
      ownerUserId: "team-env",
      providedOwnerUserId: "team-env",
      showsPublishedCopy: true,
      reason: "host-offline",
    });
    await settleEpicSession();
    expectReturnDamping(authority);

    await user.click(
      await screen.findByRole("button", {
        name: "Continue on label-team-host",
      }),
    );

    await waitFor(() =>
      expect(cloneTargetState.continueRequest).toHaveBeenCalledWith(
        "chat.continueHere",
        expect.objectContaining({ chatId: CHAT_ID }),
      ),
    );
    expect(cloneTargetState.openTile).not.toHaveBeenCalled();
    expect(cloneTargetState.cloneAttempt).not.toHaveBeenCalled();
    expect(cloneTargetState.toast).toHaveBeenCalledTimes(1);
    expect(cloneTargetState.toast).toHaveBeenCalledWith(
      "This agent's sandbox still exists. Resume it instead.",
    );
  });

  it("uses the existing Clone action when the pooled Continue action is refused for another environment", async () => {
    const authority = offerTeamContinuation({
      kind: "refused",
      reason: "other-environment",
      ownerHostId: null,
    });
    const user = userEvent.setup();
    renderContainer({
      ownerUserId: "team-env",
      providedOwnerUserId: "team-env",
      showsPublishedCopy: true,
      reason: "host-offline",
    });
    await settleEpicSession();
    expectReturnDamping(authority);

    await user.click(
      await screen.findByRole("button", {
        name: "Continue on label-team-host",
      }),
    );

    await waitFor(() =>
      expect(cloneTargetState.cloneAttempt).toHaveBeenCalledTimes(1),
    );
    expect(cloneTargetState.cloneAttempt.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ targetHostId: "host-test" }),
    );
    expect(cloneTargetState.openTile).not.toHaveBeenCalled();
    expect(cloneTargetState.toast).not.toHaveBeenCalled();
  });
});

describe("ChatDeadTileBannerContainer - ownership resolution", () => {
  it("resolves a collaborator's chat to the foreign copy and keeps Clone", async () => {
    renderContainer({
      ownerUserId: COLLABORATOR_USER_ID,
      providedOwnerUserId: COLLABORATOR_USER_ID,
      showsPublishedCopy: true,
      reason: "host-offline",
    });
    await settleEpicSession();

    const text = screen.getByTestId("banner-under-test").textContent;
    expect(text).toContain("belongs to another collaborator");
    // The two claims the incident banner made and this copy must not: the
    // machine's liveness, and a raw host id label.
    expect(text).not.toContain("is offline");
    expect(text).not.toContain("owner-host-1");
    expect(screen.getByRole("button", { name: "Clone agent" })).toBeTruthy();
  });

  it("keeps the own-chat copy when the record's owner IS the signed-in user", async () => {
    renderContainer({
      ownerUserId: VIEWER_USER_ID,
      providedOwnerUserId: undefined,
      showsPublishedCopy: false,
      reason: "host-offline",
    });
    await settleEpicSession();

    const text = screen.getByTestId("banner-under-test").textContent;
    expect(text).toContain(
      'Clone this agent to continue while "owner-host-1" is offline; the original stays there.',
    );
    expect(text).not.toContain("belongs to another collaborator");
  });

  it("says the active host when nothing names the host a clone lands on", async () => {
    renderContainer({
      ownerUserId: COLLABORATOR_USER_ID,
      providedOwnerUserId: COLLABORATOR_USER_ID,
      showsPublishedCopy: true,
      reason: "host-offline",
    });
    await settleEpicSession();

    expect(screen.getByTestId("banner-under-test").textContent).toContain(
      "Cloning creates your own agent on the active host.",
    );
  });

  it("names the active host a clone lands on once the directory labels it", async () => {
    directoryList.rows = [remoteEntry("host-test", null)];
    renderContainer({
      ownerUserId: COLLABORATOR_USER_ID,
      providedOwnerUserId: COLLABORATOR_USER_ID,
      showsPublishedCopy: true,
      reason: "host-offline",
    });
    await settleEpicSession();

    expect(screen.getByTestId("banner-under-test").textContent).toContain(
      "Cloning creates your own agent on label-host-test.",
    );
  });

  it("names the collaborator the task's list names, in the real container", async () => {
    collaboratorEntries = [
      {
        role: "editor",
        accessType: "direct",
        environmentId: null,
        grantedAt: 1,
        grantedBy: VIEWER_USER_ID,
        user: {
          userId: COLLABORATOR_USER_ID,
          profile: {
            displayName: "Ada Lovelace",
            email: "",
            avatarUrl: "",
            handle: "",
          },
        },
        team: null,
      },
    ];
    renderContainer({
      ownerUserId: COLLABORATOR_USER_ID,
      providedOwnerUserId: COLLABORATOR_USER_ID,
      showsPublishedCopy: true,
      reason: "host-offline",
    });
    await settleEpicSession();

    await waitFor(() => {
      expect(screen.getByTestId("banner-under-test").textContent).toContain(
        "This agent belongs to Ada Lovelace and runs on their computer, which isn't connected here.",
      );
    });
  });

  it("never claims a published copy the mounting surface is not showing", async () => {
    renderContainer({
      ownerUserId: COLLABORATOR_USER_ID,
      providedOwnerUserId: COLLABORATOR_USER_ID,
      showsPublishedCopy: false,
      reason: "host-offline",
    });
    await settleEpicSession();

    const text = screen.getByTestId("banner-under-test").textContent;
    expect(text).toContain("belongs to another collaborator");
    expect(text).not.toContain("published copy");
  });
});

describe("ChatDeadTileBannerContainer - an owner not yet told apart", () => {
  const OWNER_HOST_ID = "owner-host-1";

  it("keeps the own-chat copy, never a collaborator's, while the team environment list has not answered", async () => {
    environments.pool = true;
    environments.list = undefined;
    renderContainer({
      ownerUserId: COLLABORATOR_USER_ID,
      providedOwnerUserId: COLLABORATOR_USER_ID,
      showsPublishedCopy: false,
      reason: "host-offline",
    });
    await settleEpicSession();

    const text = screen.getByTestId("banner-under-test").textContent;
    expect(text).not.toContain("belongs to another collaborator");
    expect(text).toContain(
      'Clone this agent to continue while "owner-host-1" is offline; the original stays there.',
    );
  });

  it("names the collaborator once the list has answered without the owner", async () => {
    environments.pool = true;
    environments.list = { environments: [] };
    renderContainer({
      ownerUserId: COLLABORATOR_USER_ID,
      providedOwnerUserId: COLLABORATOR_USER_ID,
      showsPublishedCopy: false,
      reason: "host-offline",
    });
    await settleEpicSession();

    expect(screen.getByTestId("banner-under-test").textContent).toContain(
      "belongs to another collaborator",
    );
  });

  it("says the sandbox is out when the owner host's row is a team sandbox, before the list answers", async () => {
    environments.pool = true;
    environments.list = undefined;
    const row = remoteEntry(OWNER_HOST_ID, sandboxFacts("team-1"));
    installHostConnectionRegistrySource({
      directory: {
        findById: (hostId) => (hostId === row.hostId ? { ...row } : null),
        onDirectoryChanged: () => ({ dispose: () => undefined }),
      },
      leases: null,
    });
    renderContainer({
      ownerUserId: COLLABORATOR_USER_ID,
      providedOwnerUserId: COLLABORATOR_USER_ID,
      showsPublishedCopy: true,
      reason: "host-offline",
    });
    await settleEpicSession();

    const text = screen.getByTestId("banner-under-test").textContent;
    expect(text).toContain("This chat's host isn't available");
    expect(text).not.toContain("belongs to another collaborator");
  });
});

describe("ChatDeadTileBannerContainer - the sandbox's own state", () => {
  const ROW = sandboxSummaryFixture({
    id: "sbx-c",
    hostId: "owner-host-1",
    displayName: "e2e-sbx-stop3",
  });

  async function mountOffline(showsPublishedCopy: boolean) {
    renderContainer({
      ownerUserId: VIEWER_USER_ID,
      providedOwnerUserId: undefined,
      showsPublishedCopy,
      reason: "host-offline",
    });
    await settleEpicSession();
  }

  function destroy(): void {
    sandboxHookSources.task = {
      kind: "ended",
      ended: {
        name: "e2e-sbx-stop3",
        end: {
          state: "destroyed",
          destroyedAt: new Date(2026, 9, 27, 6, 21).getTime(),
          cause: "verb",
          actor: "Dana",
          idleMinutes: null,
        },
      },
    };
  }

  it("states a destroyed sandbox's end in one line, by its name, with Continue on another host and Details", async () => {
    destroy();
    await mountOffline(false);

    const line = screen.getByTestId("banner-under-test");
    expect(line.textContent).toBe(
      "e2e-sbx-stop3 was destroyed on Oct 27 at 06:21 by Dana. Its files are gone; this chat stays readable.Continue on another hostDetails",
    );
    await userEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(
      (await screen.findByTestId("task-sandbox-end-details")).textContent,
    ).not.toContain("UTC");
  });

  it("draws nothing over a copy of a destroyed sandbox's chat: the copy's footer states the end", async () => {
    destroy();
    await mountOffline(true);

    expect(screen.queryByTestId("banner-under-test")).toBeNull();
  });

  it.each([
    ["resting", "suspended"],
    ["unreachable", "awake"],
    ["stopping", "stopping"],
  ] as const)(
    "shows no generic offline banner for a %s sandbox: its footer owns the line",
    async (_name, state) => {
      sandboxHookSources.sandboxes = [sandboxSummaryFixture({ ...ROW, state })];
      await mountOffline(true);

      expect(screen.queryByTestId("banner-under-test")).toBeNull();
    },
  );
});

describe("ChatDeadTileBannerContainer - answered-host reasons", () => {
  it.each([
    ["chat-not-visible", 'history isn\'t available on "owner-host-1"'],
    ["chat-not-on-this-host", "history is no longer on this host"],
  ] as const)(
    "keeps the %s explanation and Clone offer when its awake sandbox answered",
    async (reason, explanation) => {
      sandboxHookSources.sandboxes = [
        sandboxSummaryFixture({
          id: "sbx-answered",
          hostId: "owner-host-1",
          displayName: "e2e-sbx-answered",
          state: "awake",
        }),
      ];
      renderContainer({
        ownerUserId: VIEWER_USER_ID,
        providedOwnerUserId: undefined,
        showsPublishedCopy: true,
        reason,
      });
      await screen.findByRole("button", { name: "Clone agent" });
      const banner = screen.getByTestId("banner-under-test");
      expect(banner.getAttribute("data-reason")).toBe(reason);
      expect(banner.textContent).toContain(explanation);
      expect(banner.textContent).not.toContain("offline");
      expect(screen.getByRole("button", { name: "Clone agent" })).toBeTruthy();
    },
  );
});
