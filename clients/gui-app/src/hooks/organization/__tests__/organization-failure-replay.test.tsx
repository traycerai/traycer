import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationView } from "@traycer/protocol/host/organization/contracts";
import { useOrganization } from "@/hooks/organization/organization-context";
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
  // Holds the host's answers back until a test releases them.
  const gate: { current: Promise<void> | null } = { current: null };
  const mutateAsync = vi.fn<(variables: unknown) => Promise<unknown>>();
  const client = {
    getActiveHostId: () => identity.hostId,
    getRequestContextUserId: () => identity.userId,
    requestWithSignal: async (
      method: string,
      params: { readonly taskIds: readonly string[] },
    ): Promise<OrganizationView> => {
      if (method !== "organization.refresh")
        return Promise.reject(new Error(`unexpected request ${method}`));
      refreshes.push([...params.taskIds]);
      await gate.current;
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
  return { client, identity, hostView, refreshes, gate, mutateAsync };
});

vi.mock("@/lib/host", () => ({
  useHostClient: () => state.client,
  useAuthService: () => ({
    revalidateCurrentContextAfterInvalidation: () => Promise.resolve(null),
  }),
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
  useHostMethodSupport: () => true,
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
    useHostMutation: () => ({ mutateAsync: state.mutateAsync }),
  };
});

vi.mock("@/components/organization/organization-dialogs", () => ({
  OrganizationDialogHost: () => null,
}));

vi.mock("@/lib/epic-selectors", async (load) => {
  const actual = await load<typeof import("@/lib/epic-selectors")>();
  return { ...actual, useRegisteredEpicLocalHome: () => false };
});

const FAILURE_1: OrganizationView["failures"][number] = {
  commandIds: ["old-command-1"],
  scope: "group:group-1",
  reason: "invalid",
  message: "historical failure",
};
const FAILURE_HISTORIC: OrganizationView["failures"][number] = {
  commandIds: ["old-command-0"],
  scope: "group:group-1",
  reason: "invalid",
  message: "older historical failure",
};
const FAILURE_2: OrganizationView["failures"][number] = {
  commandIds: ["new-command-2"],
  scope: "group:group-1",
  reason: "invalid",
  message: "genuinely new failure",
};

function viewWithFailures(
  failures: OrganizationView["failures"],
): OrganizationView {
  return {
    catalog: [],
    groups: { version: "1", groups: [], memberships: [] },
    appearances: [
      { taskId: "task-a", version: "0", color: null, icon: null },
      { taskId: "task-b", version: "0", color: null, icon: null },
    ],
    taskLabels: {},
    ready: true,
    authenticationRequired: false,
    pending: [],
    failures,
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

/** Shows how many failures the provider's current view carries (or none yet). */
function ViewProbe() {
  const view = useOrganization()?.view;
  return (
    <output data-testid="view">
      {view === undefined ? "no-view" : `failures:${view.failures.length}`}
    </output>
  );
}

/** Issues one real organization command through the provider's context. */
function CommandProbe() {
  const organization = useOrganization();
  return (
    <button
      type="button"
      onClick={() =>
        void organization?.command({
          kind: "appearance",
          taskId: "task-a",
          color: null,
        })
      }
    >
      send command
    </button>
  );
}

function tree(queryClient: QueryClient) {
  return (
    <QueryClientProvider client={queryClient}>
      <OrganizationProvider>
        <ViewProbe />
        <CommandProbe />
      </OrganizationProvider>
    </QueryClientProvider>
  );
}

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** Resolves once the probe shows the view and no refresh is still in flight. */
async function settledWith(queryClient: QueryClient, failureCount: number) {
  await waitFor(() => {
    expect(screen.getByTestId("view").textContent).toBe(
      `failures:${failureCount}`,
    );
    expect(queryClient.isFetching()).toBe(0);
  });
}

function toastDescriptions(): (string | undefined)[] {
  return warning.mock.calls.map(
    (call) => (call[1] as { description?: string } | undefined)?.description,
  );
}

const warning = vi.spyOn(toast, "warning").mockImplementation(() => "toast");

beforeEach(() => {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  state.identity.hostId = "host-1";
  state.hostView.current = viewWithFailures([FAILURE_1]);
  state.refreshes.length = 0;
  state.gate.current = null;
  state.mutateAsync.mockReset();
  warning.mockClear();
});

afterEach(() => {
  cleanup();
});

/** The scenario ran without issuing a command: nothing wrote at startup. */
function expectNoCommand(): void {
  expect(state.mutateAsync).not.toHaveBeenCalled();
}

describe("organization historical failure replay (real query hook)", () => {
  it("does not toast the host's retained historical failures on a fresh mount", async () => {
    openTask("task-a");
    const queryClient = newClient();
    render(tree(queryClient));
    await settledWith(queryClient, 1);
    expect(toastDescriptions()).toEqual([]);
    expectNoCommand();
  });
  it("does not toast historical failures again on unmount/remount with no command", async () => {
    openTask("task-a");
    const queryClient = newClient();
    const first = render(tree(queryClient));
    await settledWith(queryClient, 1);
    first.unmount();
    warning.mockClear();
    render(tree(queryClient));
    await settledWith(queryClient, 1);
    expect(toastDescriptions()).toEqual([]);
    expectNoCommand();
  });
  it("does not toast historical failures after a scope (host) reset", async () => {
    openTask("task-a");
    const queryClient = newClient();
    const rendered = render(tree(queryClient));
    await settledWith(queryClient, 1);
    warning.mockClear();
    const refreshesBefore = state.refreshes.length;
    state.identity.hostId = "host-2";
    act(() => rendered.rerender(tree(queryClient)));
    await waitFor(() =>
      expect(state.refreshes.length).toBeGreaterThan(refreshesBefore),
    );
    await settledWith(queryClient, 1);
    expect(toastDescriptions()).toEqual([]);
    expectNoCommand();
  });
  it("treats a fresh baseline with an extra historical failure as history after a stale cached view, then toasts a new failure once", async () => {
    openTask("task-a");
    const queryClient = newClient();
    const first = render(tree(queryClient));
    await settledWith(queryClient, 1);
    first.unmount();
    warning.mockClear();

    // While the app was closed the host retained one more failure. The
    // remount first projects the cached one-failure view, then the fresh one.
    state.hostView.current = viewWithFailures([FAILURE_HISTORIC, FAILURE_1]);
    const refreshesBefore = state.refreshes.length;
    render(tree(queryClient));
    await waitFor(() =>
      expect(state.refreshes.length).toBeGreaterThan(refreshesBefore),
    );
    await settledWith(queryClient, 2);
    expect(toastDescriptions()).toEqual([]);

    state.hostView.current = viewWithFailures([
      FAILURE_HISTORIC,
      FAILURE_1,
      FAILURE_2,
    ]);
    act(() => {
      openTask("task-b");
    });
    await settledWith(queryClient, 3);
    expect(toastDescriptions()).toEqual(["genuinely new failure"]);
    expectNoCommand();
  });
  it("holds the baseline through a delayed first live view, then toasts a new failure once", async () => {
    openTask("task-a");
    let release: () => void = () => {};
    state.gate.current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queryClient = newClient();
    render(tree(queryClient));
    await waitFor(() => expect(state.refreshes.length).toBeGreaterThan(0));
    expect(screen.getByTestId("view").textContent).toBe("no-view");
    expect(toastDescriptions()).toEqual([]);

    state.gate.current = null;
    release();
    await settledWith(queryClient, 1);
    expect(toastDescriptions()).toEqual([]);

    state.hostView.current = viewWithFailures([FAILURE_1, FAILURE_2]);
    act(() => {
      openTask("task-b");
    });
    await settledWith(queryClient, 2);
    expect(toastDescriptions()).toEqual(["genuinely new failure"]);
    expectNoCommand();
  });

  it("toasts a failure of this scope's own command that the first response carries, while still suppressing historical ones", async () => {
    openTask("task-a");
    state.hostView.current = viewWithFailures([FAILURE_1]);
    let release: () => void = () => {};
    state.gate.current = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.mutateAsync.mockResolvedValue({
      commandId: "ignored",
      disposition: "durably-accepted",
    });
    const queryClient = newClient();
    render(tree(queryClient));
    await waitFor(() => expect(state.refreshes.length).toBeGreaterThan(0));

    // The command is issued while the first response is still held.
    fireEvent.click(screen.getByText("send command"));
    await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(1));
    const sent = state.mutateAsync.mock.calls[0]?.[0] as {
      command: { commandId: string };
    };
    state.hostView.current = viewWithFailures([
      FAILURE_1,
      { ...FAILURE_2, commandIds: [sent.command.commandId] },
    ]);
    state.gate.current = null;
    release();
    await settledWith(queryClient, 2);

    expect(toastDescriptions()).toEqual(["genuinely new failure"]);
  });

  it("takes a not-ready first baseline as history and still toasts a later new failure once", async () => {
    openTask("task-a");
    state.hostView.current = {
      ...viewWithFailures([FAILURE_1]),
      ready: false,
    };
    const queryClient = newClient();
    render(tree(queryClient));
    await settledWith(queryClient, 1);
    expect(toastDescriptions()).toEqual([]);

    state.hostView.current = viewWithFailures([FAILURE_1, FAILURE_2]);
    act(() => {
      openTask("task-b");
    });
    await settledWith(queryClient, 2);
    expect(toastDescriptions()).toEqual(["genuinely new failure"]);
    expectNoCommand();
  });
});
