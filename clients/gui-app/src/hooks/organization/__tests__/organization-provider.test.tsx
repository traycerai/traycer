import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationView } from "@traycer/protocol/host/organization/contracts";
import { OrganizationProvider } from "@/hooks/organization/organization-provider";
import { useOrganization } from "@/hooks/organization/organization-context";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { tabItemId } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";

const state = vi.hoisted(() => {
  const identity = {
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
  return { client, identity, view };
});

vi.mock("@/lib/host", () => ({
  useHostClient: () => state.client,
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: state.identity.hostId,
    requestContextUserId: state.identity.userId,
  }),
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => true,
}));

vi.mock("@/stores/auth/auth-store", () => ({
  authorizesCloudCapability: () => true,
  useAuthStore: <T,>(
    selector: (auth: {
      readonly status: "signed-in";
      readonly contextMetadata: { readonly userId: string };
    }) => T,
  ): T =>
    selector({
      status: "signed-in",
      contextMetadata: { userId: state.identity.authUserId },
    }),
}));

vi.mock("@/hooks/host/use-surface-host-stream-binding", () => ({
  useSurfaceHostStreamBinding: () => null,
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: () => ({ data: state.view }),
  useHostMutation: () => ({
    mutateAsync: vi.fn(() =>
      Promise.resolve({
        commandId: "command-1",
        disposition: "durably-accepted",
      }),
    ),
  }),
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
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  state.identity.hostId = "host-1";
  state.identity.userId = "user-1";
  state.identity.authUserId = "user-1";
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
});
