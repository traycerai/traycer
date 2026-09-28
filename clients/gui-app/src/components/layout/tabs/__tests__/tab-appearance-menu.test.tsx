import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { ListTaskLight } from "@traycer/protocol/host/epic/unary-schemas";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { TabAppearanceMenu } from "../tab-appearance-menu";
import { TabGroupChip } from "../tab-group-chip";
import { useTabsStore } from "@/stores/tabs/store";
import type { HeaderTab } from "@/stores/tabs/types";
import type { OrganizationContextValue } from "@/hooks/organization/organization-context";
import type {
  EpicTaskContexts,
  UseEpicGetTaskContextsOptions,
} from "@/hooks/epic/use-epic-get-task-contexts-query";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

type TaskContextPayload = Pick<
  EpicTaskContexts,
  "tasksById" | "localHomedTaskIds"
>;

interface OrganizationFixtureState {
  organization: OrganizationContextValue | null;
  loadTaskContext: Mock<() => Promise<TaskContextPayload>>;
}

const navigation = vi.hoisted(() => ({ navigate: vi.fn(), open: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigation.navigate,
}));
vi.mock("@/lib/tab-navigation", () => ({
  navigateToTabIntent: navigation.open,
}));
vi.mock("@/lib/commands/actions/new-epic", () => ({
  openNewEpicIntent: () => ({ kind: "new-epic" }),
}));
const organizationState = vi.hoisted((): OrganizationFixtureState => ({
  organization: null,
  loadTaskContext: vi.fn<() => Promise<TaskContextPayload>>(),
}));
vi.mock("@/hooks/organization/organization-context", () => ({
  useOrganization: () => organizationState.organization,
}));
vi.mock("@/hooks/epic/use-epic-get-task-contexts-query", () => ({
  useEpicGetTaskContexts: (
    taskIds: readonly string[],
    userId: string | null,
    options: UseEpicGetTaskContextsOptions,
  ): EpicTaskContexts => {
    const query = useQuery(
      queryOptions({
        queryKey: hostQueryKeys.epicTaskContexts(
          "host-1",
          userId ?? "unknown-user",
          taskIds,
        ),
        queryFn: organizationState.loadTaskContext,
        enabled: options.enabled && userId !== null,
        retry: false,
      }),
    );
    return {
      tasksById: query.data?.tasksById ?? new Map<string, ListTaskLight>(),
      localHomedTaskIds: query.data?.localHomedTaskIds ?? new Set<string>(),
      isFetching: query.isFetching,
      error: query.error,
    };
  },
}));

const TAB: HeaderTab = {
  kind: "epic",
  id: "tab-a",
  epicId: "epic-a",
  hostId: null,
  route: "/epics/epic-a",
  name: "Alpha",
  icon: null,
  canClose: true,
  canDuplicate: false,
  canOpenInNewWindow: false,
};

function renderMenu(): void {
  render(
    <QueryClientProvider client={queryClient}>
      <ContextMenu open>
        <ContextMenuTrigger>Open</ContextMenuTrigger>
        <ContextMenuContent>
          <TabAppearanceMenu tab={TAB} />
        </ContextMenuContent>
      </ContextMenu>
    </QueryClientProvider>,
  );
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
const organizationClient = new HostClient<HostRpcRegistry>({
  registry: hostRpcRegistry,
  invalidator: { invalidateHostScope: () => undefined },
  messenger: new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "request-1",
    handlers: {},
  }),
});
vi.spyOn(organizationClient, "getActiveHostId").mockReturnValue("host-1");
vi.spyOn(organizationClient, "getRequestContextUserId").mockReturnValue(
  "user-1",
);

function organizationFixture(): OrganizationContextValue {
  return {
    client: organizationClient,
    supported: true,
    userId: "user-1",
    view: undefined,
    register: () => () => undefined,
    command: () => Promise.resolve(undefined),
    refresh: () => Promise.resolve(undefined),
    openDialog: () => undefined,
  };
}

function remoteTask(): ListTaskLight {
  return {
    epic: {
      light: {
        id: "epic-a",
        title: "Alpha",
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "draft",
        createdAt: 1,
        updatedAt: 1,
        createdBy: "user-1",
        version: "1.0.0",
      },
      permission: null,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
    pinned: false,
  };
}

describe("tab appearance and grouping controls", () => {
  beforeEach(() => {
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useTabsStore.setState({
      items: [
        {
          kind: "tab",
          id: "tab:epic:tab-a",
          ref: { kind: "epic", id: "tab-a" },
        },
      ],
      stripOrder: [{ kind: "epic", id: "tab-a" }],
      groups: {
        existing: { name: "Existing", color: "#81c995", collapsed: false },
      },
    });
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "user-1", username: "user-1" },
    });
    organizationState.loadTaskContext.mockReset();
  });
  afterEach(() => cleanup());

  afterEach(() => {
    organizationState.organization = null;
    useAuthStore.setState({ status: "signed-out", contextMetadata: null });
    queryClient.clear();
  });

  it("shows retry for task-context errors and restores authorized controls after recovery", async () => {
    organizationState.organization = organizationFixture();
    let resolveRecovery: (payload: TaskContextPayload) => void = () =>
      undefined;
    const recovery = new Promise<TaskContextPayload>((resolve) => {
      resolveRecovery = resolve;
    });
    organizationState.loadTaskContext
      .mockRejectedValueOnce(new Error("task context failed"))
      .mockImplementationOnce(() => recovery);
    const refetchQueries = vi.spyOn(queryClient, "refetchQueries");
    renderMenu();

    const retry = await screen.findByRole("menuitem", {
      name: /Couldn't load task organization\. Retry/i,
    });
    expect(screen.queryByRole("menuitem", { name: "Labels" })).toBeNull();
    expect(screen.queryByText("Tab appearance")).toBeNull();

    fireEvent.click(retry);
    expect(refetchQueries).toHaveBeenCalledWith({
      queryKey: hostQueryKeys.epicTaskContexts("host-1", "user-1", ["epic-a"]),
      exact: true,
      type: "active",
    });
    await waitFor(() =>
      expect(organizationState.loadTaskContext).toHaveBeenCalledTimes(2),
    );
    await act(async () => {
      resolveRecovery({
        tasksById: new Map([["epic-a", remoteTask()]]),
        localHomedTaskIds: new Set(),
      });
      await recovery;
    });
    expect(
      await screen.findByRole("menuitem", { name: "Labels" }),
    ).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Retry/i })).toBeNull();
    refetchQueries.mockRestore();
  });

  it("shows the appearance submenu and stores a color and manual icon", () => {
    renderMenu();
    fireEvent.click(screen.getByText("Tab appearance"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Blue" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Tab icon" }), {
      target: { value: "★" },
    });
    const customization =
      useTabsStore.getState().customizations?.["epic:tab-a"];
    expect(customization).toMatchObject({ color: "#8ab4f8", icon: "★" });
  });

  it("stores a custom tab color from the appearance submenu", () => {
    renderMenu();
    fireEvent.click(screen.getByText("Tab appearance"));
    fireEvent.change(screen.getByLabelText("Custom tab color"), {
      target: { value: "#123456" },
    });

    expect(useTabsStore.getState().customizations?.["epic:tab-a"]?.color).toBe(
      "#123456",
    );
  });

  it("keeps a group's color unchanged when editing personal tab appearance", () => {
    useTabsStore.setState({
      customizations: {
        "epic:tab-a": { color: null, icon: null, groupId: "existing" },
      },
    });
    renderMenu();
    fireEvent.click(screen.getByText("Tab appearance"));
    fireEvent.change(screen.getByLabelText("Custom tab color"), {
      target: { value: "#123456" },
    });

    expect(useTabsStore.getState().customizations?.["epic:tab-a"]?.color).toBe(
      "#123456",
    );
    const groups = useTabsStore.getState().groups;
    if (groups === undefined) throw new Error("Expected the existing group");
    expect(groups.existing.color).toBe("#81c995");
  });

  it("creates a group and supports removing the tab from it", () => {
    renderMenu();
    fireEvent.click(screen.getByText("Add tab to group"));
    fireEvent.click(screen.getByText("New group"));
    const groupId =
      useTabsStore.getState().customizations?.["epic:tab-a"]?.groupId;
    expect(groupId).toBeTruthy();
    fireEvent.click(screen.getByText("Remove from group"));
    expect(
      useTabsStore.getState().customizations?.["epic:tab-a"]?.groupId,
    ).toBeNull();
  });

  it("adds a tab to an existing group", () => {
    renderMenu();
    fireEvent.click(screen.getByText("Add tab to group"));
    fireEvent.click(screen.getByText("Existing"));
    expect(
      useTabsStore.getState().customizations?.["epic:tab-a"]?.groupId,
    ).toBe("existing");
  });

  it("collapses and edits a group, including group actions", () => {
    const group = {
      name: "Alpha",
      color: "#8ab4f8",
      collapsed: false,
    } as const;
    useTabsStore.setState({
      groups: { group },
      customizations: {
        "epic:tab-a": { color: null, icon: null, groupId: "group" },
      },
    });
    const close = vi.fn();
    render(<TabGroupChip groupId="group" group={group} onClose={close} />);
    const chip = screen.getByRole("button", { name: /Alpha: collapse group/ });
    fireEvent.click(chip);
    expect(useTabsStore.getState().groups?.group.collapsed).toBe(true);
    fireEvent.contextMenu(chip);
    const groupName = screen.getByRole("textbox", { name: "Group name" });
    fireEvent.change(groupName, {
      target: { value: "Renamed" },
    });
    fireEvent.keyDown(groupName, { key: "Enter" });
    expect(useTabsStore.getState().groups?.group.name).toBe("Renamed");
    fireEvent.contextMenu(chip);
    fireEvent.click(screen.getByRole("button", { name: "Ungroup" }));
    expect(
      useTabsStore.getState().customizations?.["epic:tab-a"]?.groupId,
    ).toBeNull();
    fireEvent.contextMenu(chip);
    fireEvent.click(screen.getByRole("button", { name: "New tab in group" }));
    expect(navigation.open).toHaveBeenCalled();
    fireEvent.contextMenu(chip);
    fireEvent.click(screen.getByRole("button", { name: "Close group" }));
    expect(close).toHaveBeenCalledWith("group");
  });

  it("stores a custom color from the group color picker", () => {
    const group = {
      name: "Alpha",
      color: "#8ab4f8",
      collapsed: false,
    } as const;
    useTabsStore.setState({
      groups: { group },
      customizations: {
        "epic:tab-a": { color: null, icon: null, groupId: "group" },
      },
    });
    const close = vi.fn();
    render(<TabGroupChip groupId="group" group={group} onClose={close} />);
    fireEvent.contextMenu(
      screen.getByRole("button", { name: /Alpha: collapse group/ }),
    );
    fireEvent.change(screen.getByLabelText("Custom tab color"), {
      target: { value: "#123456" },
    });

    expect(useTabsStore.getState().groups?.group.color).toBe("#123456");
  });
});
