import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationView } from "@traycer/protocol/host/organization/contracts";
import { OrganizationProvider } from "@/hooks/organization/organization-provider";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { tabItemId } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";

/**
 * The organization subscription for a set of open tasks runs through the
 * real query hook here, so what it accepts is what TanStack hands it: on a
 * remount of a task set it has seen before, that is the cached answer of the
 * earlier mount, served before the mandatory refetch returns.
 */
const state = vi.hoisted(() => {
  const identity = { hostId: "host-1", userId: "user-1" };
  const hostView: { current: OrganizationView | null } = { current: null };
  const refreshes: string[][] = [];
  const client = {
    getActiveHostId: () => identity.hostId,
    getRequestContextUserId: () => identity.userId,
    requestWithSignal: (
      method: string,
      params: { readonly taskIds: readonly string[] },
    ): Promise<OrganizationView> => {
      if (method !== "organization.refresh")
        return Promise.reject(new Error(`unexpected request ${method}`));
      refreshes.push([...params.taskIds]);
      // A null host view is the host refusing the refresh.
      if (hostView.current === null)
        return Promise.reject(new Error("organization refresh unavailable"));
      const ids = new Set(params.taskIds);
      const view = structuredClone(hostView.current);
      return Promise.resolve({
        ...view,
        appearances: view.appearances.filter((row) => ids.has(row.taskId)),
      });
    },
  };
  return { client, identity, hostView, refreshes };
});

vi.mock("@/lib/host", () => ({
  useHostClient: () => state.client,
}));

// The no-pool plan's answer: the surface client itself. These suites test the
// organization projection, not the serving tier.
vi.mock("@/hooks/host/use-pool-tier", () => ({
  usePoolTierHostClient: <T,>(client: T): T => client,
  usePoolTierStreamClient: <T,>(client: T): T => client,
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: state.identity.hostId,
    requestContextUserId: state.identity.userId,
    canExecute: true,
  }),
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => true,
}));

vi.mock("@/stores/auth/auth-store", () => {
  const snapshot = {
    status: "signed-in",
    contextMetadata: { userId: "user-1" },
  };
  return {
    authorizesCloudCapability: () => true,
    useAuthStore: Object.assign(
      <T,>(selector: (auth: typeof snapshot) => T): T => selector(snapshot),
      { getState: () => snapshot, subscribe: () => () => {} },
    ),
  };
});

vi.mock("@/hooks/host/use-surface-host-stream-binding", () => ({
  useSurfaceHostStreamBinding: () => null,
}));

vi.mock("@/hooks/host/use-host-query", async (load) => {
  const actual = await load<typeof import("@/hooks/host/use-host-query")>();
  return {
    ...actual,
    useHostMutation: () => ({
      mutateAsync: vi.fn(() =>
        Promise.resolve({
          commandId: "command-1",
          disposition: "durably-accepted",
        }),
      ),
    }),
  };
});

vi.mock("@/components/organization/organization-dialogs", () => ({
  OrganizationDialogHost: () => null,
}));

vi.mock("@/lib/epic-selectors", async (load) => {
  const actual = await load<typeof import("@/lib/epic-selectors")>();
  return { ...actual, useRegisteredEpicLocalHome: () => false };
});

const APPEARANCES: OrganizationView["appearances"] = [
  { taskId: "task-a", version: "0", color: null, icon: null },
  { taskId: "task-b", version: "0", color: null, icon: null },
];

function viewWithoutGroup(): OrganizationView {
  return {
    catalog: [],
    groups: { version: "2", groups: [], memberships: [] },
    appearances: APPEARANCES,
    taskLabels: {},
    ready: true,
    authenticationRequired: false,
    pending: [],
    failures: [],
  };
}

function viewWithGroup(): OrganizationView {
  return {
    ...viewWithoutGroup(),
    groups: {
      version: "1",
      groups: [
        { groupId: "group-1", name: "Tracy", color: "#8ab4f8", position: 0 },
      ],
      memberships: [{ taskId: "task-a", groupId: "group-1", position: 0 }],
    },
  };
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

function refreshesFor(taskIds: readonly string[]): number {
  return state.refreshes.filter(
    (ids) =>
      ids.length === taskIds.length && ids.every((id, i) => id === taskIds[i]),
  ).length;
}

beforeEach(() => {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  state.hostView.current = viewWithGroup();
  state.refreshes.length = 0;
});

afterEach(() => {
  cleanup();
});

describe("organization subscription remount", () => {
  it.each([
    { refetch: "succeeds", hostAnswers: true },
    // A failed refetch counts as fetched after mount while the cached answer
    // stays in `data`; it must be rejected the same way.
    { refetch: "fails", hostAnswers: false },
  ])(
    "never projects an earlier mount's cached view over the host's current one when the remount refetch $refetch",
    async ({ hostAnswers }) => {
      const tabA = openTask("task-a");
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      render(
        <QueryClientProvider client={queryClient}>
          <OrganizationProvider>{null}</OrganizationProvider>
        </QueryClientProvider>,
      );
      await waitFor(() => expect(tabGroupId(tabA)).toBe("group-1"));

      // The group is dissolved on the host. Opening another task changes the
      // subscribed set, so the new set's refresh carries the current view.
      state.hostView.current = viewWithoutGroup();
      let tabB = "";
      act(() => {
        tabB = openTask("task-b");
      });
      await waitFor(() => expect(tabGroupId(tabA)).toBeNull());

      // Closing it again remounts the subscription for the first set, whose
      // earlier answer still held the group.
      const groupIdsSeen: (string | null | undefined)[] = [];
      const unsubscribe = useTabsStore.subscribe((tabs) =>
        groupIdsSeen.push(tabs.customizations?.[`epic:${tabA}`]?.groupId),
      );
      const refreshesBefore = refreshesFor(["task-a"]);
      if (!hostAnswers) state.hostView.current = null;
      act(() => useEpicCanvasStore.getState().closeTab(tabB));
      await waitFor(() =>
        expect(refreshesFor(["task-a"])).toBeGreaterThan(refreshesBefore),
      );
      // Let the refetch settle either way before reading what was projected.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await waitFor(() => expect(tabGroupId(tabA)).toBeNull());
      unsubscribe();

      expect(groupIdsSeen).not.toContain("group-1");
    },
  );
});
