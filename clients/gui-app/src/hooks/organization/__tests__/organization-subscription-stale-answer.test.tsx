import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationView } from "@traycer/protocol/host/organization/contracts";
import type {
  LabelDefinition,
  TaskLabel,
} from "@traycer/protocol/host/organization/schemas";
import { OrganizationProvider } from "@/hooks/organization/organization-provider";
import {
  useOrganization,
  useOrganizationTasks,
} from "@/hooks/organization/organization-context";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { tabItemId } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";

/**
 * The subscription's cached `organization.refresh` answer is only a
 * mount-time baseline. Registering a task that is already subscribed rebuilds
 * the provider's task id array without changing its contents; that must not
 * reopen the stream or let the old baseline overwrite what a live frame
 * delivered since.
 */
interface FakeSession {
  readonly taskIds: readonly string[];
  closed: boolean;
  readonly deliver: ((frame: unknown) => void)[];
}

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
      if (method !== "organization.refresh" || hostView.current === null)
        return Promise.reject(new Error(`unexpected request ${method}`));
      refreshes.push([...params.taskIds]);
      return Promise.resolve(structuredClone(hostView.current));
    },
  };
  const sessions: FakeSession[] = [];
  const stream = {
    subscribe: (
      _method: string,
      params: { readonly taskIds: readonly string[] },
    ) => {
      const session: FakeSession = {
        taskIds: [...params.taskIds],
        closed: false,
        deliver: [],
      };
      sessions.push(session);
      return {
        onServerFrame: (callback: (frame: unknown) => void) => {
          session.deliver.push(callback);
        },
        close: () => {
          session.closed = true;
        },
      };
    },
    subscribeAvailabilityRecovered: (_listener: () => void) => () => undefined,
  };
  return { client, identity, hostView, refreshes, sessions, stream };
});

vi.mock("@/lib/host", () => ({
  useHostClient: () => state.client,
  useAuthService: () => ({
    revalidateCurrentContextAfterInvalidation: () => Promise.resolve(null),
  }),
}));

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
  useSurfaceHostStreamBinding: () => ({ wsStreamClient: state.stream }),
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

function definition(labelId: string, name: string): LabelDefinition {
  return {
    ownerId: "user-1",
    labelId,
    kind: "custom",
    systemKey: null,
    name,
    color: "#112233",
    version: "0",
  };
}

function appliedLabel(labelId: string, name: string): TaskLabel {
  return {
    ...definition(labelId, name),
    assignmentId: `${labelId}-assignment`,
  };
}

function view(
  catalog: LabelDefinition[],
  labels: TaskLabel[],
): OrganizationView {
  return {
    catalog,
    groups: { version: "0", groups: [], memberships: [] },
    appearances: [{ taskId: "task-a", version: "0", color: null, icon: null }],
    taskLabels: { "task-a": { labels, removed: [] } },
    ready: true,
    authenticationRequired: false,
    pending: [],
    failures: [],
  };
}

function openTask(taskId: string): void {
  useEpicCanvasStore.getState().openEpicTab(taskId, taskId);
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
}

const rendered: string[] = [];

function CatalogProbe() {
  const names =
    useOrganization()
      ?.view?.catalog.map((entry) => entry.name)
      .join(",") ?? "";
  rendered.push(names);
  return <output data-testid="catalog">{names}</output>;
}

// Stands in for a task menu or labels dialog registering the task it shows.
function RegisterTask() {
  useOrganizationTasks(["task-a"]);
  return null;
}

function Harness(props: { readonly registering: boolean }) {
  return (
    <QueryClientProvider client={queryClient}>
      <OrganizationProvider>
        <CatalogProbe />
        {props.registering ? <RegisterTask /> : null}
      </OrganizationProvider>
    </QueryClientProvider>
  );
}

let queryClient: QueryClient;

function sessionsFor(taskIds: readonly string[]): FakeSession[] {
  return state.sessions.filter(
    (session) =>
      session.taskIds.length === taskIds.length &&
      session.taskIds.every((id, i) => id === taskIds[i]),
  );
}

beforeEach(() => {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  state.sessions.length = 0;
  state.refreshes.length = 0;
  rendered.length = 0;
});

afterEach(() => {
  cleanup();
});

describe("organization subscription task registration", () => {
  it("keeps live labels when an already-subscribed task is registered again", async () => {
    openTask("task-a");
    state.hostView.current = view([definition("tracy", "Tracy")], []);
    const ui = render(<Harness registering={false} />);

    await waitFor(() =>
      expect(screen.getByTestId("catalog").textContent).toBe("Tracy"),
    );
    await waitFor(() => {
      expect(sessionsFor(["task-a"])).toHaveLength(1);
      expect(state.refreshes).toContainEqual(["task-a"]);
      expect(state.refreshes).toContainEqual([]);
    });
    await act(async () => {});
    const original = sessionsFor(["task-a"])[0];

    const live = {
      kind: "snapshot",
      hasBinaryPayload: false,
      view: view(
        [definition("tracy", "Tracy"), definition("amitesh", "Amitesh")],
        [appliedLabel("amitesh", "Amitesh")],
      ),
    };
    act(() => original.deliver.forEach((deliver) => deliver(live)));
    await waitFor(() =>
      expect(screen.getByTestId("catalog").textContent).toBe("Tracy,Amitesh"),
    );

    rendered.length = 0;
    ui.rerender(<Harness registering />);
    await act(async () => {});
    ui.rerender(<Harness registering={false} />);
    await act(async () => {});

    expect(rendered.length).toBeGreaterThan(0);
    for (const names of rendered) expect(names).toContain("Amitesh");
    expect(screen.getByTestId("catalog").textContent).toContain("Amitesh");
    expect(sessionsFor(["task-a"])).toEqual([original]);
    expect(original.closed).toBe(false);
  });
});
