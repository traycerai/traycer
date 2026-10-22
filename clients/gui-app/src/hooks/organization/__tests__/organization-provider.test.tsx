import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  type RenderResult,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type {
  OrganizationAction,
  OrganizationView,
} from "@traycer/protocol/host/organization/contracts";
import { OrganizationProvider } from "@/hooks/organization/organization-provider";
import { useOrganization } from "@/hooks/organization/organization-context";
import {
  cloudEpicTasksQueryKey,
  LIST_CLOUD_TASKS_REQUEST,
} from "@/lib/cloud-epic-tasks-query";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { tabItemId } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";

/** The stream transport as the provider uses it: frames, and recovery evidence. */
interface FakeStreamClient {
  readonly subscribe: () => {
    readonly onServerFrame: () => void;
    readonly close: () => void;
  };
  readonly subscribeAvailabilityRecovered: (listener: () => void) => () => void;
}

const state = vi.hoisted(() => {
  const identity: {
    hostId: string;
    userId: string;
    authUserId: string | null;
  } = {
    hostId: "host-1",
    userId: "user-1",
    authUserId: "user-1",
  };
  const view: OrganizationView = {
    catalog: [],
    groups: { version: "0", groups: [], memberships: [] },
    appearances: [],
    taskLabels: {},
    ready: true,
    authenticationRequired: false,
    pending: [],
    failures: [],
  };
  const client = {
    getActiveHostId: () => identity.hostId,
    getRequestContextUserId: () => identity.userId,
  };
  // What the host answered at its last handshake: `null` before any.
  const support: { current: boolean | null } = { current: true };
  const mutateAsync = vi.fn<
    (variables: {
      readonly command: {
        readonly commandId: string;
        readonly action: OrganizationAction;
      };
    }) => Promise<unknown>
  >();
  // The stream transport the surface binding hands out: `null` until a test
  // dials one. The host's recovery evidence is its availability listeners.
  const stream: {
    current: { readonly wsStreamClient: FakeStreamClient } | null;
  } = { current: null };
  // What the pool tier resolves the surface's stream to. `null` is the
  // no-pool plan, where the answer is the surface's own stream.
  const poolStream: { current: FakeStreamClient | null } = { current: null };
  return { client, identity, view, support, mutateAsync, stream, poolStream };
});

vi.mock("@/lib/host", () => ({
  useHostClient: () => state.client,
}));

// The no-pool plan's answer: the surface client itself. These suites test the
// organization projection, not the serving tier - except where a test dials a
// pool stream, which is what a pool build resolves the surface's stream to.
vi.mock("@/hooks/host/use-pool-tier", () => ({
  usePoolTierHostClient: <T,>(client: T): T => client,
  usePoolTierStreamClient: (client: FakeStreamClient | null) =>
    state.poolStream.current ?? client,
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: state.identity.hostId,
    requestContextUserId: state.identity.userId,
  }),
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => state.support.current,
  useHostSupportsMethod: () => state.support.current === true,
}));

vi.mock("@/stores/auth/auth-store", () => ({
  authorizesCloudCapability: () => true,
  useAuthStore: Object.assign(
    <T,>(
      selector: (auth: {
        readonly status: "signed-in";
        readonly contextMetadata: { readonly userId: string } | null;
      }) => T,
    ): T => selector(authSnapshot()),
    {
      getState: authSnapshot,
      subscribe: () => () => {},
    },
  ),
}));

function authSnapshot(): {
  readonly status: "signed-in";
  readonly contextMetadata: { readonly userId: string } | null;
} {
  return {
    status: "signed-in",
    contextMetadata:
      state.identity.authUserId === null
        ? null
        : { userId: state.identity.authUserId },
  };
}

vi.mock("@/hooks/host/use-surface-host-stream-binding", () => ({
  useSurfaceHostStreamBinding: () => state.stream.current,
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: () => ({ data: state.view }),
  useHostMutation: () => ({ mutateAsync: state.mutateAsync }),
}));

vi.mock("@/components/organization/organization-dialogs", () => ({
  OrganizationDialogHost: () => null,
}));

vi.mock("@/lib/epic-selectors", async (load) => {
  const actual = await load<typeof import("@/lib/epic-selectors")>();
  return { ...actual, useRegisteredEpicLocalHome: () => false };
});

function emptyView(): OrganizationView {
  return {
    catalog: [],
    groups: { version: "0", groups: [], memberships: [] },
    appearances: [],
    taskLabels: {},
    ready: true,
    authenticationRequired: false,
    pending: [],
    failures: [],
  };
}

function viewWithGroup(
  memberships: OrganizationView["groups"]["memberships"],
): OrganizationView {
  return {
    ...emptyView(),
    groups: {
      version: "0",
      groups: [
        { groupId: "group-1", name: "Project", color: "#8ab4f8", position: 0 },
      ],
      memberships,
    },
    appearances: [
      { taskId: "task-1", version: "0", color: null, icon: null },
      { taskId: "task-2", version: "0", color: null, icon: null },
    ],
  };
}

function renderProvider(queryClient: QueryClient, children: ReactNode) {
  return render(
    <QueryClientProvider client={queryClient}>
      <OrganizationProvider>{children}</OrganizationProvider>
    </QueryClientProvider>,
  );
}

function resetStores(): void {
  state.stream.current = null;
  state.poolStream.current = null;
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  state.identity.hostId = "host-1";
  state.identity.userId = "user-1";
  state.identity.authUserId = "user-1";
  state.support.current = true;
  state.mutateAsync.mockReset();
  state.mutateAsync.mockImplementation(() =>
    Promise.resolve({
      commandId: "command-1",
      disposition: "durably-accepted",
    }),
  );
  state.view = emptyView();
}

function OrganizationStateProbe() {
  const organization = useOrganization();
  return (
    <output data-testid="organization-state">
      {organization?.view === undefined ? "hidden" : "visible"}
    </output>
  );
}

function OrganizationRefreshProbe() {
  const organization = useOrganization();
  return (
    <button type="button" onClick={() => void organization?.refresh()}>
      Refresh organization
    </button>
  );
}

function ActiveOrganizationRefreshQuery(props: {
  readonly hostId: string;
  readonly userId: string;
  readonly taskId: string;
  readonly fetch: () => void;
}) {
  useQuery(
    queryOptions({
      queryKey: [
        ...hostQueryKeys.method<HostRpcRegistry, "organization.refresh">(
          props.hostId,
          "organization.refresh",
          { taskIds: [props.taskId] },
        ),
        props.userId,
      ],
      queryFn: () => {
        props.fetch();
        return Promise.resolve(emptyView());
      },
    }),
  );
  return null;
}

function openTask(taskId: string): string {
  const tabId = useEpicCanvasStore.getState().openEpicTab(taskId, taskId);
  const refs = useEpicCanvasStore.getState().openTabOrder.map((id) => ({
    kind: "epic" as const,
    id,
  }));
  useTabsStore.setState({
    items: refs.map((ref) => ({
      kind: "tab" as const,
      id: tabItemId(ref),
      ref,
    })),
    stripOrder: refs,
    activeItemId: refs.length > 0 ? tabItemId(refs[refs.length - 1]) : null,
    systemTabs: { history: null, settings: null },
  });
  return tabId;
}

function tabGroupId(tabId: string): string | null | undefined {
  return useTabsStore.getState().customizations?.[`epic:${tabId}`]?.groupId;
}

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  cleanup();
  resetStores();
});

describe("OrganizationProvider lifecycle projection", () => {
  it("opens saved siblings when a grouped task is opened", async () => {
    const taskOneTabId = openTask("task-1");
    state.view = viewWithGroup([
      { taskId: "task-1", groupId: "group-1", position: 0 },
      { taskId: "task-2", groupId: "group-1", position: 1 },
    ]);
    const queryClient = new QueryClient();

    renderProvider(queryClient, null);

    await waitFor(() => {
      expect(
        useEpicCanvasStore
          .getState()
          .openTabOrder.map(
            (tabId) => useEpicCanvasStore.getState().tabsById[tabId]?.epicId,
          ),
      ).toEqual(["task-1", "task-2"]);
    });
    expect(tabGroupId(taskOneTabId)).toBe("group-1");
  });

  it("preserves a locally closed sibling across host scope changes until a task is explicitly reopened", async () => {
    const taskOneTabId = openTask("task-1");
    const taskTwoTabId = openTask("task-2");
    state.view = viewWithGroup([
      { taskId: "task-1", groupId: "group-1", position: 0 },
      { taskId: "task-2", groupId: "group-1", position: 1 },
    ]);
    const queryClient = new QueryClient();
    const rendered = renderProvider(queryClient, null);

    await waitFor(() => expect(tabGroupId(taskOneTabId)).toBe("group-1"));
    act(() => useEpicCanvasStore.getState().closeTab(taskTwoTabId));
    expect(useEpicCanvasStore.getState().openTabOrder).not.toContain(
      taskTwoTabId,
    );

    state.identity.hostId = "host-2";
    act(() => {
      rendered.rerender(
        <QueryClientProvider client={queryClient}>
          <OrganizationProvider>{null}</OrganizationProvider>
        </QueryClientProvider>,
      );
    });
    await waitFor(() =>
      expect(useEpicCanvasStore.getState().openTabOrder).not.toContain(
        taskTwoTabId,
      ),
    );

    act(() => useEpicCanvasStore.getState().closeTab(taskOneTabId));
    act(() => {
      void useEpicCanvasStore.getState().openEpicTab("task-1", "task-1");
    });
    await waitFor(() =>
      expect(
        useEpicCanvasStore
          .getState()
          .openTabOrder.map(
            (tabId) => useEpicCanvasStore.getState().tabsById[tabId]?.epicId,
          ),
      ).toEqual(["task-1", "task-2"]),
    );
  });

  it("refreshes only the active organization scope and refuses stale live identities", async () => {
    const matchingTaskOne = vi.fn();
    const matchingTaskTwo = vi.fn();
    const otherHost = vi.fn();
    const otherUser = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderProvider(
      queryClient,
      <>
        <OrganizationRefreshProbe />
        <ActiveOrganizationRefreshQuery
          hostId="host-1"
          userId="user-1"
          taskId="task-1"
          fetch={matchingTaskOne}
        />
        <ActiveOrganizationRefreshQuery
          hostId="host-1"
          userId="user-1"
          taskId="task-2"
          fetch={matchingTaskTwo}
        />
        <ActiveOrganizationRefreshQuery
          hostId="host-2"
          userId="user-1"
          taskId="task-1"
          fetch={otherHost}
        />
        <ActiveOrganizationRefreshQuery
          hostId="host-1"
          userId="user-2"
          taskId="task-1"
          fetch={otherUser}
        />
      </>,
    );
    await waitFor(() => {
      expect(matchingTaskOne).toHaveBeenCalledTimes(1);
      expect(matchingTaskTwo).toHaveBeenCalledTimes(1);
      expect(otherHost).toHaveBeenCalledTimes(1);
      expect(otherUser).toHaveBeenCalledTimes(1);
    });
    matchingTaskOne.mockClear();
    matchingTaskTwo.mockClear();
    otherHost.mockClear();
    otherUser.mockClear();

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh organization" }),
    );
    await waitFor(() => {
      expect(matchingTaskOne).toHaveBeenCalledTimes(1);
      expect(matchingTaskTwo).toHaveBeenCalledTimes(1);
    });
    expect(otherHost).not.toHaveBeenCalled();
    expect(otherUser).not.toHaveBeenCalled();

    matchingTaskOne.mockClear();
    matchingTaskTwo.mockClear();
    state.identity.hostId = "host-2";
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Refresh organization" }),
      );
      await Promise.resolve();
    });
    expect(matchingTaskOne).not.toHaveBeenCalled();
    expect(matchingTaskTwo).not.toHaveBeenCalled();

    state.identity.hostId = "host-1";
    state.identity.userId = "user-2";
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Refresh organization" }),
      );
      await Promise.resolve();
    });
    expect(matchingTaskOne).not.toHaveBeenCalled();
    expect(matchingTaskTwo).not.toHaveBeenCalled();

    state.identity.userId = "user-1";
    state.identity.authUserId = "user-2";
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Refresh organization" }),
      );
      await Promise.resolve();
    });
    expect(matchingTaskOne).not.toHaveBeenCalled();
    expect(matchingTaskTwo).not.toHaveBeenCalled();
  });

  it("keeps an open task visible and ungroups it after remote membership removal", async () => {
    const taskOneTabId = openTask("task-1");
    const taskTwoTabId = openTask("task-2");
    const initialOrder = [...useEpicCanvasStore.getState().openTabOrder];
    state.view = viewWithGroup([
      { taskId: "task-1", groupId: "group-1", position: 0 },
      { taskId: "task-2", groupId: "group-1", position: 1 },
    ]);
    const queryClient = new QueryClient();
    const rendered = renderProvider(queryClient, null);

    await waitFor(() => expect(tabGroupId(taskOneTabId)).toBe("group-1"));

    state.view = viewWithGroup([
      { taskId: "task-2", groupId: "group-1", position: 0 },
    ]);
    act(() => {
      rendered.rerender(
        <QueryClientProvider client={queryClient}>
          <OrganizationProvider>{null}</OrganizationProvider>
        </QueryClientProvider>,
      );
    });

    await waitFor(() => expect(tabGroupId(taskOneTabId)).toBeNull());
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual(initialOrder);
    expect(tabGroupId(taskTwoTabId)).toBe("group-1");
  });

  it("does not invalidate history pagination when a new page only adds metadata", () => {
    state.view = {
      ...emptyView(),
      taskLabels: {
        "task-1": { labels: [], removed: [] },
      },
    };
    const queryClient = new QueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const rendered = renderProvider(queryClient, null);
    act(() => {});
    invalidateQueries.mockClear();

    state.view = {
      ...state.view,
      taskLabels: {
        ...state.view.taskLabels,
        "task-2": { labels: [], removed: [] },
      },
    };
    act(() => {
      rendered.rerender(
        <QueryClientProvider client={queryClient}>
          <OrganizationProvider>{null}</OrganizationProvider>
        </QueryClientProvider>,
      );
    });

    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it("invalidates same-account cloud task caches on every host, excluding other accounts", async () => {
    const queryClient = new QueryClient();
    const sameHostKey = cloudEpicTasksQueryKey(
      "host-1",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    const otherHostKey = cloudEpicTasksQueryKey(
      "host-2",
      "user-1",
      LIST_CLOUD_TASKS_REQUEST,
    );
    const otherAccountKey = cloudEpicTasksQueryKey(
      "host-1",
      "user-2",
      LIST_CLOUD_TASKS_REQUEST,
    );
    queryClient.setQueryData(sameHostKey, { tasks: [], hasMore: false });
    queryClient.setQueryData(otherHostKey, { tasks: [], hasMore: false });
    queryClient.setQueryData(otherAccountKey, { tasks: [], hasMore: false });
    const rendered = renderProvider(queryClient, null);
    act(() => {});

    state.view = {
      ...state.view,
      catalog: [
        {
          ownerId: "user-1",
          labelId: "changed",
          name: "Changed",
          color: "#8ab4f8",
          version: "1",
          kind: "custom",
          systemKey: null,
        },
      ],
    };
    act(() => {
      rendered.rerender(
        <QueryClientProvider client={queryClient}>
          <OrganizationProvider>{null}</OrganizationProvider>
        </QueryClientProvider>,
      );
    });

    await waitFor(() => {
      expect(queryClient.getQueryState(sameHostKey)?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(otherHostKey)?.isInvalidated).toBe(true);
    });
    expect(queryClient.getQueryState(otherAccountKey)?.isInvalidated).toBe(
      false,
    );
  });

  it("invalidates history when a confirmed view removes an appearance without a history marker", () => {
    state.view = {
      ...emptyView(),
      appearances: [
        { taskId: "task-1", version: "1", color: "#8ab4f8", icon: null },
      ],
    };
    const queryClient = new QueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const rendered = renderProvider(queryClient, null);
    act(() => {});
    invalidateQueries.mockClear();

    state.view = emptyView();
    act(() => {
      rendered.rerender(
        <QueryClientProvider client={queryClient}>
          <OrganizationProvider>{null}</OrganizationProvider>
        </QueryClientProvider>,
      );
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope("host-1", "organization.history"),
    });
  });

  it("invalidates History when its invalidation marker changes without a loaded task", () => {
    state.view = { ...emptyView(), historyInvalidation: "marker-1" };
    const queryClient = new QueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const rendered = renderProvider(queryClient, null);
    act(() => {});
    invalidateQueries.mockClear();

    state.view = { ...state.view, historyInvalidation: "marker-2" };
    act(() => {
      rendered.rerender(
        <QueryClientProvider client={queryClient}>
          <OrganizationProvider>{null}</OrganizationProvider>
        </QueryClientProvider>,
      );
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: hostQueryKeys.methodScope("host-1", "organization.history"),
    });
  });

  it("does not retain another account's group projection", async () => {
    const taskOneTabId = openTask("task-1");
    state.view = viewWithGroup([
      { taskId: "task-1", groupId: "group-1", position: 0 },
    ]);
    const queryClient = new QueryClient();
    const rendered = renderProvider(queryClient, null);
    await waitFor(() => expect(tabGroupId(taskOneTabId)).toBe("group-1"));

    state.identity.userId = "user-2";
    state.identity.authUserId = "user-2";
    state.view = {
      ...emptyView(),
      appearances: [
        { taskId: "task-1", version: "0", color: null, icon: null },
      ],
    };
    act(() => {
      rendered.rerender(
        <QueryClientProvider client={queryClient}>
          <OrganizationProvider>{null}</OrganizationProvider>
        </QueryClientProvider>,
      );
    });

    await waitFor(() => expect(tabGroupId(taskOneTabId)).toBeNull());
  });

  it("hides organization state while the host request context belongs to another account", async () => {
    state.view = viewWithGroup([
      { taskId: "task-1", groupId: "group-1", position: 0 },
    ]);
    const queryClient = new QueryClient();
    const rendered = renderProvider(queryClient, <OrganizationStateProbe />);

    await waitFor(() =>
      expect(screen.getByTestId("organization-state").textContent).toBe(
        "visible",
      ),
    );

    state.identity.authUserId = "user-2";
    act(() => {
      rendered.rerender(
        <QueryClientProvider client={queryClient}>
          <OrganizationProvider>
            <OrganizationStateProbe />
          </OrganizationProvider>
        </QueryClientProvider>,
      );
    });

    expect(screen.getByTestId("organization-state").textContent).toBe("hidden");
  });

  it("clears a stale persisted group on a same-account cold-start snapshot", async () => {
    const taskTabId = openTask("task-cold-start");
    useTabsStore.setState({
      groups: {
        "old-group": {
          name: "Old group",
          color: "#8ab4f8",
          collapsed: false,
        },
      },
      customizations: {
        [`epic:${taskTabId}`]: {
          color: null,
          icon: null,
          groupId: "old-group",
          organizationOwnerId: "user-1",
        },
      },
    });
    state.view = emptyView();
    const queryClient = new QueryClient();

    renderProvider(queryClient, null);

    await waitFor(() => expect(tabGroupId(taskTabId)).toBeNull());
    expect(useEpicCanvasStore.getState().openTabOrder).toContain(taskTabId);
  });

  it("preserves a cold-start customization while identity is unknown, then keeps it for the same account", async () => {
    const taskTabId = openTask("task-unknown-identity");
    const key = `epic:${taskTabId}`;
    const persisted = {
      color: "#123456",
      icon: "UX",
      groupId: "saved-group",
      pendingGroupId: "pending-group",
      organizationOwnerId: "user-1",
    };
    useTabsStore.setState({
      groups: {
        "saved-group": {
          name: "Saved group",
          color: "#8ab4f8",
          collapsed: true,
        },
      },
      customizations: { [key]: persisted },
    });
    state.view = { ...emptyView(), ready: false };
    state.identity.authUserId = null;
    const queryClient = new QueryClient();
    const rendered = renderProvider(queryClient, null);

    expect(useTabsStore.getState().customizations?.[key]).toEqual(persisted);

    state.identity.authUserId = "user-1";
    act(() => {
      rendered.rerender(
        <QueryClientProvider client={queryClient}>
          <OrganizationProvider>{null}</OrganizationProvider>
        </QueryClientProvider>,
      );
    });

    await waitFor(() =>
      expect(useTabsStore.getState().customizations?.[key]).toEqual(persisted),
    );
  });

  it("clears a persisted customization when the cold-start identity resolves to another account", async () => {
    const taskTabId = openTask("task-other-identity");
    const key = `epic:${taskTabId}`;
    useTabsStore.setState({
      customizations: {
        [key]: {
          color: "#123456",
          icon: "UX",
          groupId: "saved-group",
          pendingGroupId: "pending-group",
          organizationOwnerId: "user-1",
        },
      },
    });
    state.view = { ...emptyView(), ready: false };
    state.identity.authUserId = null;
    const queryClient = new QueryClient();
    const rendered = renderProvider(queryClient, null);

    state.identity.authUserId = "user-2";
    act(() => {
      rendered.rerender(
        <QueryClientProvider client={queryClient}>
          <OrganizationProvider>{null}</OrganizationProvider>
        </QueryClientProvider>,
      );
    });

    await waitFor(() => {
      const customization = useTabsStore.getState().customizations?.[key];
      expect(customization).toMatchObject({
        color: null,
        icon: null,
        groupId: null,
      });
      expect(customization?.pendingGroupId).toBeUndefined();
      expect(customization?.organizationOwnerId).toBeUndefined();
    });
  });
});

describe("OrganizationProvider draft group intent", () => {
  function startDraftInGroup(taskId: string, groupId: string): string {
    const tabId = openTask(taskId);
    useTabsStore.setState({
      customizations: {
        [`epic:${tabId}`]: {
          color: null,
          icon: null,
          groupId: null,
          pendingGroupId: groupId,
        },
      },
    });
    return tabId;
  }

  function pendingGroupIdOf(tabId: string): string | null | undefined {
    return useTabsStore.getState().customizations?.[`epic:${tabId}`]
      ?.pendingGroupId;
  }

  /** The account has the group, and has nothing yet for the task. */
  function viewWithOnlyTheGroup(): OrganizationView {
    return {
      ...emptyView(),
      groups: {
        version: "0",
        groups: [
          {
            groupId: "group-1",
            name: "Project",
            color: "#8ab4f8",
            position: 0,
          },
        ],
        memberships: [],
      },
    };
  }

  it("sends the intent for a task with no cloud metadata yet, and keeps it until the host acknowledges", async () => {
    const taskTabId = startDraftInGroup("task-new", "group-1");
    state.view = viewWithOnlyTheGroup();
    let acknowledge: () => void = () => undefined;
    state.mutateAsync.mockImplementation(
      () =>
        new Promise((resolve) => {
          acknowledge = () =>
            resolve({
              commandId: "command-1",
              disposition: "durably-accepted",
            });
        }),
    );

    renderProvider(new QueryClient(), null);

    await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(1));
    expect(state.mutateAsync.mock.calls[0]?.[0].command.action).toEqual({
      kind: "groups",
      operations: [
        {
          operation: "moveTask",
          taskId: "task-new",
          groupId: "group-1",
          position: 0,
        },
      ],
    });
    expect(pendingGroupIdOf(taskTabId)).toBe("group-1");

    await act(async () => {
      acknowledge();
      await Promise.resolve();
    });

    await waitFor(() => expect(pendingGroupIdOf(taskTabId)).toBeNull());
  });

  describe("after a refused send", () => {
    function nextViewFrame(
      rendered: RenderResult,
      queryClient: QueryClient,
      frame: string,
    ): void {
      state.view = { ...state.view, historyInvalidation: frame };
      act(() => {
        rendered.rerender(
          <QueryClientProvider client={queryClient}>
            <OrganizationProvider>{null}</OrganizationProvider>
          </QueryClientProvider>,
        );
      });
    }

    /** A turn in which a settled command has been handled by the provider. */
    async function settleCommand(): Promise<void> {
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
    }

    /**
     * The one transport the window keeps for the whole test: a recovery does
     * not rebuild it. `recover` is the host reporting that a session reopened
     * after a drop or a stall.
     */
    function fakeStream(): {
      readonly client: FakeStreamClient;
      readonly recover: () => void;
    } {
      const listeners = new Set<() => void>();
      return {
        client: {
          subscribe: () => ({
            onServerFrame: () => undefined,
            close: () => undefined,
          }),
          subscribeAvailabilityRecovered: (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
        },
        recover: () => {
          act(() => {
            for (const listener of [...listeners]) listener();
          });
        },
      };
    }

    function dialStream(): { readonly recover: () => void } {
      const stream = fakeStream();
      state.stream.current = { wsStreamClient: stream.client };
      return { recover: stream.recover };
    }

    it("keeps the intent when the send is rejected, then a recovery sends it again on the very same view and the acknowledgement clears it", async () => {
      const host = dialStream();
      const taskTabId = startDraftInGroup("task-new", "group-1");
      state.view = viewWithOnlyTheGroup();
      const viewBeforeRecovery = state.view;
      state.mutateAsync.mockImplementationOnce(() =>
        Promise.reject(new Error("host refused")),
      );
      state.mutateAsync.mockImplementationOnce(() =>
        Promise.resolve({
          commandId: "command-2",
          disposition: "durably-accepted",
        }),
      );
      renderProvider(new QueryClient(), null);
      await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(1));
      await settleCommand();
      expect(pendingGroupIdOf(taskTabId)).toBe("group-1");

      host.recover();

      // No new data came with the recovery: the resend is the wake alone.
      expect(state.view).toBe(viewBeforeRecovery);
      await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(pendingGroupIdOf(taskTabId)).toBeNull());
    });

    it("waits on a recovery from the pool's stream, the one its commands ride, and ignores one from the surface's own", async () => {
      const surface = fakeStream();
      const pool = fakeStream();
      state.stream.current = { wsStreamClient: surface.client };
      state.poolStream.current = pool.client;
      const taskTabId = startDraftInGroup("task-new", "group-1");
      state.view = viewWithOnlyTheGroup();
      state.mutateAsync.mockImplementationOnce(() =>
        Promise.reject(new Error("host refused")),
      );
      renderProvider(new QueryClient(), null);
      await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(1));
      await settleCommand();

      // A host the commands do not go to has recovered: that says nothing
      // about the one the refused intent is waiting on.
      surface.recover();
      await settleCommand();
      expect(state.mutateAsync).toHaveBeenCalledTimes(1);
      expect(pendingGroupIdOf(taskTabId)).toBe("group-1");

      pool.recover();

      await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(pendingGroupIdOf(taskTabId)).toBeNull());
    });

    describe("when the user decides the same task's group in the meantime", () => {
      /** Hands the test the provider's own command, the one every menu and drag goes through. */
      function CommandProbe(props: {
        readonly capture: (
          command: (action: OrganizationAction) => Promise<void>,
        ) => void;
      }) {
        const organization = useOrganization();
        const command = organization?.command;
        const { capture } = props;
        useEffect(() => {
          if (command !== undefined) capture(command);
        }, [command, capture]);
        return null;
      }

      function moveTaskTo(taskId: string, groupId: string): OrganizationAction {
        return {
          kind: "groups",
          operations: [{ operation: "moveTask", taskId, groupId, position: 0 }],
        };
      }

      /** The group of every move the provider has sent, in order. */
      function groupsMovedTo(): string[] {
        return state.mutateAsync.mock.calls.flatMap(([variables]) => {
          const { action } = variables.command;
          return action.kind === "groups"
            ? action.operations.flatMap((operation) =>
                operation.operation === "moveTask" ? [operation.groupId] : [],
              )
            : [];
        });
      }

      /** Renders the provider, lets the draft's automatic move be refused, and returns the user's own command. */
      async function refuseTheAutomaticMove(): Promise<{
        readonly choose: (action: OrganizationAction) => Promise<void>;
        readonly rendered: RenderResult;
        readonly queryClient: QueryClient;
      }> {
        let choose: (action: OrganizationAction) => Promise<void> = () =>
          Promise.reject(new Error("the provider has not rendered"));
        const queryClient = new QueryClient();
        const rendered = renderProvider(
          queryClient,
          <CommandProbe
            capture={(command) => {
              choose = command;
            }}
          />,
        );
        await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(1));
        await settleCommand();
        return {
          choose: (action) => choose(action),
          rendered,
          queryClient,
        };
      }

      it("forgets the intent when the host accepts that choice, so a recovery never sends the old group back", async () => {
        const host = dialStream();
        const taskTabId = startDraftInGroup("task-new", "group-1");
        state.view = viewWithOnlyTheGroup();
        state.mutateAsync.mockImplementationOnce(() =>
          Promise.reject(new Error("host refused")),
        );
        const { choose } = await refuseTheAutomaticMove();
        expect(pendingGroupIdOf(taskTabId)).toBe("group-1");

        await act(async () => {
          await choose(moveTaskTo("task-new", "group-2"));
        });
        host.recover();
        await settleCommand();

        expect(groupsMovedTo()).toEqual(["group-1", "group-2"]);
        expect(pendingGroupIdOf(taskTabId)).toBeNull();
      });

      it("forgets the intent when the host accepts the task leaving every group", async () => {
        const host = dialStream();
        const taskTabId = startDraftInGroup("task-new", "group-1");
        state.view = viewWithOnlyTheGroup();
        state.mutateAsync.mockImplementationOnce(() =>
          Promise.reject(new Error("host refused")),
        );
        const { choose } = await refuseTheAutomaticMove();

        await act(async () => {
          await choose({
            kind: "groups",
            operations: [{ operation: "removeTask", taskId: "task-new" }],
          });
        });
        host.recover();
        await settleCommand();

        expect(groupsMovedTo()).toEqual(["group-1"]);
        expect(pendingGroupIdOf(taskTabId)).toBeNull();
      });

      it("keeps the intent when that choice is refused too, and a recovery still sends the old group", async () => {
        const host = dialStream();
        const taskTabId = startDraftInGroup("task-new", "group-1");
        state.view = viewWithOnlyTheGroup();
        state.mutateAsync.mockImplementationOnce(() =>
          Promise.reject(new Error("host refused")),
        );
        state.mutateAsync.mockImplementationOnce(() =>
          Promise.reject(new Error("host refused")),
        );
        const { choose } = await refuseTheAutomaticMove();

        await act(async () => {
          await choose(moveTaskTo("task-new", "group-2")).catch(
            () => undefined,
          );
        });
        expect(pendingGroupIdOf(taskTabId)).toBe("group-1");

        host.recover();

        await waitFor(() =>
          expect(groupsMovedTo()).toEqual(["group-1", "group-2", "group-1"]),
        );
        await waitFor(() => expect(pendingGroupIdOf(taskTabId)).toBeNull());
      });

      it("does not read a membership in the view as that choice: the intent outlives a frame that already shows the task in a group", async () => {
        const taskTabId = startDraftInGroup("task-new", "group-1");
        state.view = viewWithOnlyTheGroup();
        state.mutateAsync.mockImplementation(() =>
          Promise.reject(new Error("host refused")),
        );
        const queryClient = new QueryClient();
        const rendered = renderProvider(queryClient, null);
        await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(1));
        await settleCommand();

        // The host's own projection carries the optimistic edit, so this is
        // the frame the very next send is drawn from.
        state.view = {
          ...state.view,
          groups: {
            ...state.view.groups,
            memberships: [
              { taskId: "task-new", groupId: "group-1", position: 0 },
            ],
          },
        };
        nextViewFrame(rendered, queryClient, "frame-with-membership");
        await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(2));
        await settleCommand();

        expect(pendingGroupIdOf(taskTabId)).toBe("group-1");
      });
    });

    it("starts no second command for a send that has not come back, whatever frames or recoveries arrive meanwhile", async () => {
      const host = dialStream();
      const taskTabId = startDraftInGroup("task-new", "group-1");
      state.view = viewWithOnlyTheGroup();
      let acknowledge: () => void = () => undefined;
      state.mutateAsync.mockImplementation(
        () =>
          new Promise((resolve) => {
            acknowledge = () =>
              resolve({
                commandId: "command-1",
                disposition: "durably-accepted",
              });
          }),
      );
      const queryClient = new QueryClient();
      const rendered = renderProvider(queryClient, null);
      await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(1));

      nextViewFrame(rendered, queryClient, "frame-1");
      host.recover();
      nextViewFrame(rendered, queryClient, "frame-2");
      host.recover();
      await settleCommand();

      expect(state.mutateAsync).toHaveBeenCalledTimes(1);
      expect(pendingGroupIdOf(taskTabId)).toBe("group-1");

      await act(async () => {
        acknowledge();
        await Promise.resolve();
      });
      await waitFor(() => expect(pendingGroupIdOf(taskTabId)).toBeNull());
      expect(state.mutateAsync).toHaveBeenCalledTimes(1);
    });

    /**
     * Sends the test settles by hand, in the order they were made. `overlap`
     * is the most that were ever unsettled at once.
     */
    function controlledSends(): {
      readonly sends: Array<{
        readonly acknowledge: () => void;
        readonly refuse: () => void;
      }>;
      readonly overlap: () => number;
    } {
      const sends: Array<{
        readonly acknowledge: () => void;
        readonly refuse: () => void;
      }> = [];
      let unsettled = 0;
      let mostUnsettled = 0;
      state.mutateAsync.mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            unsettled += 1;
            mostUnsettled = Math.max(mostUnsettled, unsettled);
            sends.push({
              acknowledge: () => {
                unsettled -= 1;
                resolve({
                  commandId: `command-${sends.length}`,
                  disposition: "durably-accepted",
                });
              },
              refuse: () => {
                unsettled -= 1;
                reject(new Error("host refused"));
              },
            });
          }),
      );
      return { sends, overlap: () => mostUnsettled };
    }

    it("acts on a recovery that landed while the send was in flight, once that send is refused, with nothing else to wake it", async () => {
      const host = dialStream();
      const taskTabId = startDraftInGroup("task-new", "group-1");
      state.view = viewWithOnlyTheGroup();
      const viewBeforeRecovery = state.view;
      const held = controlledSends();
      renderProvider(new QueryClient(), null);
      await waitFor(() => expect(held.sends).toHaveLength(1));

      host.recover();
      await settleCommand();

      // The guard: the first send has not come back, so no second one yet.
      expect(state.view).toBe(viewBeforeRecovery);
      expect(held.sends).toHaveLength(1);

      await act(async () => {
        held.sends[0]?.refuse();
        await Promise.resolve();
      });

      // No further frame, no further recovery: the refusal alone wakes it.
      await waitFor(() => expect(held.sends).toHaveLength(2));
      expect(pendingGroupIdOf(taskTabId)).toBe("group-1");
      await act(async () => {
        held.sends[1]?.acknowledge();
        await Promise.resolve();
      });
      await waitFor(() => expect(pendingGroupIdOf(taskTabId)).toBeNull());
      expect(held.sends).toHaveLength(2);
      expect(held.overlap()).toBe(1);
    });

    it("still stops at the cap after such a recovery, and never has two sends unsettled", async () => {
      const MAX_ATTEMPTS = 3;
      const host = dialStream();
      const taskTabId = startDraftInGroup("task-new", "group-1");
      state.view = viewWithOnlyTheGroup();
      const held = controlledSends();
      const queryClient = new QueryClient();
      const rendered = renderProvider(queryClient, null);
      await waitFor(() => expect(held.sends).toHaveLength(1));
      const refuseLatest = async (): Promise<void> => {
        await act(async () => {
          held.sends.at(-1)?.refuse();
          await Promise.resolve();
        });
      };
      host.recover();
      await refuseLatest();
      // The recovery gave the budget back, so this send is the first of three.
      await waitFor(() => expect(held.sends).toHaveLength(2));

      for (let sent = 2; sent <= MAX_ATTEMPTS; sent++) {
        await refuseLatest();
        await settleCommand();
        nextViewFrame(rendered, queryClient, `frame-${sent}`);
        await waitFor(() => expect(held.sends).toHaveLength(sent + 1));
      }
      await refuseLatest();
      await settleCommand();
      nextViewFrame(rendered, queryClient, "frame-after-cap");
      await settleCommand();

      expect(held.sends).toHaveLength(MAX_ATTEMPTS + 1);
      expect(pendingGroupIdOf(taskTabId)).toBe("group-1");
      expect(held.overlap()).toBe(1);
    });

    it("stops after three refusals and keeps the intent, then a recovery gives the attempts back", async () => {
      const MAX_ATTEMPTS = 3;
      const host = dialStream();
      const taskTabId = startDraftInGroup("task-new", "group-1");
      state.view = viewWithOnlyTheGroup();
      state.mutateAsync.mockImplementation(() =>
        Promise.reject(new Error("host refused")),
      );
      const queryClient = new QueryClient();
      const rendered = renderProvider(queryClient, null);
      await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(1));

      for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
        await settleCommand();
        nextViewFrame(rendered, queryClient, `frame-${attempt}`);
        await waitFor(() =>
          expect(state.mutateAsync).toHaveBeenCalledTimes(attempt),
        );
      }
      await settleCommand();
      nextViewFrame(rendered, queryClient, "frame-after-last-attempt");
      nextViewFrame(rendered, queryClient, "another-frame");
      await settleCommand();

      expect(state.mutateAsync).toHaveBeenCalledTimes(MAX_ATTEMPTS);
      expect(pendingGroupIdOf(taskTabId)).toBe("group-1");

      host.recover();

      await waitFor(() =>
        expect(state.mutateAsync).toHaveBeenCalledTimes(MAX_ATTEMPTS + 1),
      );
      expect(pendingGroupIdOf(taskTabId)).toBe("group-1");
    });
  });

  it("drops an intent whose group is gone from the account, and sends nothing", async () => {
    const taskTabId = startDraftInGroup("task-new", "deleted-group");
    state.view = viewWithOnlyTheGroup();

    renderProvider(new QueryClient(), null);

    await waitFor(() => expect(pendingGroupIdOf(taskTabId)).toBeNull());
    expect(state.mutateAsync).not.toHaveBeenCalled();
  });
});

describe("OrganizationProvider host support", () => {
  function SupportProbe() {
    const organization = useOrganization();
    return (
      <output data-testid="support">
        {`${String(organization?.hostSupport)} ${String(organization?.supported)} ${organization?.view === undefined ? "no-view" : "view"}`}
      </output>
    );
  }

  it.each([
    { hostSupport: true, expected: "true true view" },
    { hostSupport: false, expected: "false false view" },
    { hostSupport: null, expected: "null false view" },
  ])(
    "reports $hostSupport as the host's answer and keeps the cached view on screen",
    ({ hostSupport, expected }) => {
      state.support.current = hostSupport;
      state.view = viewWithGroup([
        { taskId: "task-1", groupId: "group-1", position: 0 },
      ]);

      renderProvider(new QueryClient(), <SupportProbe />);

      expect(screen.getByTestId("support").textContent).toBe(expected);
    },
  );
});
