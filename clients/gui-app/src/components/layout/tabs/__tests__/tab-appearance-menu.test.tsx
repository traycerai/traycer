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
import {
  isFoundTaskContext,
  type GetTaskContextsResponse,
  type ListTaskLight,
  type TaskContextResolution,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { OrganizationView } from "@traycer/protocol/host/organization/contracts";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { TabAppearanceMenu } from "../tab-appearance-menu";
import { TabGroupChip } from "../tab-group-chip";
import { useGroupEditorStore } from "@/stores/tabs/group-editor-store";
import { useTabsStore } from "@/stores/tabs/store";
import type { HeaderTab } from "@/stores/tabs/types";
import type { OrganizationContextValue } from "@/hooks/organization/organization-context";
import type {
  EpicTaskContexts,
  UseEpicGetTaskContextsOptions,
} from "@/hooks/epic/use-epic-get-task-contexts-query";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

interface OrganizationFixtureState {
  organization: OrganizationContextValue | null;
  loadTaskContext: Mock<() => Promise<GetTaskContextsResponse>>;
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
  loadTaskContext: vi.fn<() => Promise<GetTaskContextsResponse>>(),
}));
vi.mock("@/hooks/organization/organization-context", async (load) => ({
  ...(await load<typeof import("@/hooks/organization/organization-context")>()),
  useOrganization: () => organizationState.organization,
  useOrganizationTasks: () => organizationState.organization,
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
    // The query cache holds the wire response, as the real hook's does, so
    // readers that scan other surfaces' cached batches see the real shape.
    const tasksById = new Map<string, ListTaskLight>();
    for (const [taskId, resolution] of Object.entries(
      query.data?.tasks ?? {},
    )) {
      if (isFoundTaskContext(resolution))
        tasksById.set(taskId, resolution.task);
    }
    return {
      tasksById,
      localHomedTaskIds: new Set(query.data?.localHomedTaskIds ?? []),
      isFetching: query.isFetching,
      isPending: query.isPending,
      error: query.error,
      refetch: () => Promise.resolve(),
      refetchBatches: [],
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

/** The group of the anchor "Edit group…" asked to open, if it asked. */
function requestedGroup(): string | null {
  const { anchors, requestedAnchorId } = useGroupEditorStore.getState();
  return requestedAnchorId === null
    ? null
    : (anchors[requestedAnchorId] ?? null);
}

/** The menu, beside the "existing" group's chip when it has one to open its editor on. */
function renderMenu(withGroupChip: boolean): void {
  render(
    <QueryClientProvider client={queryClient}>
      {withGroupChip ? (
        <TabGroupChip
          groupId="existing"
          group={{ name: "Existing", color: "#81c995", collapsed: false }}
          onClose={() => undefined}
        />
      ) : null}
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
const activeHostId = vi
  .spyOn(organizationClient, "getActiveHostId")
  .mockReturnValue("host-1");
vi.spyOn(organizationClient, "getRequestContextUserId").mockReturnValue(
  "user-1",
);

function organizationFixture(
  view: OrganizationView | undefined,
): OrganizationContextValue {
  return {
    client: organizationClient,
    supported: true,
    userId: "user-1",
    view,
    register: () => () => undefined,
    command: () => Promise.resolve(undefined),
    refresh: () => Promise.resolve(undefined),
    openDialog: () => undefined,
  };
}

function remoteTask(epicId: string): ListTaskLight {
  return {
    epic: {
      light: {
        id: epicId,
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

function taskContextsResponse(resolutions: {
  readonly found: readonly string[];
  readonly localHomed: readonly string[];
}): GetTaskContextsResponse {
  const tasks: GetTaskContextsResponse["tasks"] = {};
  for (const epicId of resolutions.found) {
    tasks[epicId] = { status: "found", task: remoteTask(epicId) };
  }
  return { tasks, localHomedTaskIds: [...resolutions.localHomed] };
}

describe("tab appearance and grouping controls", () => {
  beforeEach(() => {
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useGroupEditorStore.setState({ anchorId: null, requestedAnchorId: null });
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
    organizationState.organization = organizationFixture(undefined);
    let resolveRecovery: (response: GetTaskContextsResponse) => void = () =>
      undefined;
    const recovery = new Promise<GetTaskContextsResponse>((resolve) => {
      resolveRecovery = resolve;
    });
    organizationState.loadTaskContext
      .mockRejectedValueOnce(new Error("task context failed"))
      .mockImplementationOnce(() => recovery);
    const refetchQueries = vi.spyOn(queryClient, "refetchQueries");
    renderMenu(false);

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
      resolveRecovery(
        taskContextsResponse({ found: ["epic-a"], localHomed: [] }),
      );
      await recovery;
    });
    expect(
      await screen.findByRole("menuitem", { name: "Labels" }),
    ).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Retry/i })).toBeNull();
    refetchQueries.mockRestore();
  });

  describe("task context already cached by another surface", () => {
    // The tab strip resolves every open tab's context in one batch, which is a
    // different cache entry from this tab's own single-task lookup.
    const stripBatchKeyOnHost = (hostId: string, userId: string) =>
      hostQueryKeys.epicTaskContexts(hostId, userId, ["epic-a", "epic-b"]);
    const stripBatchKey = (userId: string) =>
      stripBatchKeyOnHost("host-1", userId);

    beforeEach(() => {
      activeHostId.mockReturnValue("host-1");
      organizationState.organization = organizationFixture(undefined);
      // This tab's own lookup never answers, so whatever the menu shows comes
      // from the other batch.
      organizationState.loadTaskContext.mockReturnValue(
        new Promise<GetTaskContextsResponse>(() => undefined),
      );
    });

    it("shows the organization controls at once, before the tab's own lookup answers", () => {
      queryClient.setQueryData(
        stripBatchKey("user-1"),
        taskContextsResponse({ found: ["epic-a", "epic-b"], localHomed: [] }),
      );
      renderMenu(false);

      expect(screen.getByRole("menuitem", { name: "Labels" })).toBeTruthy();
      expect(
        screen.getByRole("menuitem", { name: "Task appearance" }),
      ).toBeTruthy();
      expect(
        screen.getByRole("menuitem", { name: "Add to group" }),
      ).toBeTruthy();
      expect(screen.queryByText("Tab appearance")).toBeNull();
      expect(organizationState.loadTaskContext).toHaveBeenCalledTimes(1);
    });

    it("shows the local tab appearance for a task the cached batch marks local-homed", () => {
      queryClient.setQueryData(
        stripBatchKey("user-1"),
        taskContextsResponse({
          found: ["epic-a", "epic-b"],
          localHomed: ["epic-a"],
        }),
      );
      renderMenu(false);

      expect(screen.getByText("Tab appearance")).toBeTruthy();
      expect(screen.queryByRole("menuitem", { name: "Labels" })).toBeNull();
    });

    it("lets the tab's own lookup take over once it answers", async () => {
      queryClient.setQueryData(
        stripBatchKey("user-1"),
        taskContextsResponse({ found: ["epic-a", "epic-b"], localHomed: [] }),
      );
      let answerOwnLookup: (response: GetTaskContextsResponse) => void = () =>
        undefined;
      const ownLookup = new Promise<GetTaskContextsResponse>((resolve) => {
        answerOwnLookup = resolve;
      });
      organizationState.loadTaskContext.mockReturnValue(ownLookup);
      renderMenu(false);
      expect(screen.getByRole("menuitem", { name: "Labels" })).toBeTruthy();

      await act(async () => {
        answerOwnLookup(
          taskContextsResponse({ found: ["epic-a"], localHomed: ["epic-a"] }),
        );
        await ownLookup;
      });

      expect(await screen.findByText("Tab appearance")).toBeTruthy();
      expect(screen.queryByRole("menuitem", { name: "Labels" })).toBeNull();
    });

    // A task deleted (or no longer visible) since the strip's batch was cached
    // must not keep its controls once the tab's own, fresher lookup says so.
    const unresolvedResolutions: readonly TaskContextResolution[] = [
      { status: "confirmed-absent" },
      { status: "unknown", reason: "not-found-or-not-permitted" },
    ];
    it.each(unresolvedResolutions)(
      "drops the stand-in controls when the tab's own lookup settles as $status",
      async (resolution) => {
        queryClient.setQueryData(
          stripBatchKey("user-1"),
          taskContextsResponse({ found: ["epic-a", "epic-b"], localHomed: [] }),
        );
        let answerOwnLookup: (response: GetTaskContextsResponse) => void = () =>
          undefined;
        const ownLookup = new Promise<GetTaskContextsResponse>((resolve) => {
          answerOwnLookup = resolve;
        });
        organizationState.loadTaskContext.mockReturnValue(ownLookup);
        renderMenu(false);
        expect(screen.getByRole("menuitem", { name: "Labels" })).toBeTruthy();

        await act(async () => {
          answerOwnLookup({
            tasks: { "epic-a": resolution },
            localHomedTaskIds: [],
          });
          await ownLookup;
        });

        await waitFor(() =>
          expect(screen.queryByRole("menuitem", { name: "Labels" })).toBeNull(),
        );
        expect(
          screen.queryByRole("menuitem", { name: "Task appearance" }),
        ).toBeNull();
        expect(
          screen.queryByRole("menuitem", { name: "Add to group" }),
        ).toBeNull();
        expect(screen.queryByText("Tab appearance")).toBeNull();
        expect(screen.queryByRole("menuitem", { name: /Retry/i })).toBeNull();
      },
    );

    it.each(unresolvedResolutions)(
      "keeps the controls away while the tab's own lookup refetches after settling as $status",
      async (resolution) => {
        queryClient.setQueryData(
          stripBatchKey("user-1"),
          taskContextsResponse({ found: ["epic-a", "epic-b"], localHomed: [] }),
        );
        // The first answer settles the lookup; every later call stays in
        // flight, which is what a background refetch looks like to the menu.
        organizationState.loadTaskContext
          .mockResolvedValueOnce({
            tasks: { "epic-a": resolution },
            localHomedTaskIds: [],
          })
          .mockReturnValue(
            new Promise<GetTaskContextsResponse>(() => undefined),
          );
        renderMenu(false);
        await waitFor(() =>
          expect(screen.queryByRole("menuitem", { name: "Labels" })).toBeNull(),
        );
        const ownLookupKey = hostQueryKeys.epicTaskContexts(
          "host-1",
          "user-1",
          ["epic-a"],
        );

        act(() => {
          void queryClient.refetchQueries({
            queryKey: ownLookupKey,
            exact: true,
          });
        });

        await waitFor(() =>
          expect(organizationState.loadTaskContext).toHaveBeenCalledTimes(2),
        );
        expect(queryClient.isFetching({ queryKey: ownLookupKey })).toBe(1);
        expect(screen.queryByRole("menuitem", { name: "Labels" })).toBeNull();
        expect(
          screen.queryByRole("menuitem", { name: "Task appearance" }),
        ).toBeNull();
        expect(
          screen.queryByRole("menuitem", { name: "Add to group" }),
        ).toBeNull();
        expect(screen.queryByText("Tab appearance")).toBeNull();
      },
    );

    it("offers no organization controls from a batch that did not resolve the task", () => {
      queryClient.setQueryData(
        stripBatchKey("user-1"),
        taskContextsResponse({ found: ["epic-b"], localHomed: [] }),
      );
      renderMenu(false);

      expect(screen.queryByRole("menuitem", { name: "Labels" })).toBeNull();
      expect(screen.queryByText("Tab appearance")).toBeNull();
    });

    it("ignores a batch cached for another account", () => {
      queryClient.setQueryData(
        stripBatchKey("user-2"),
        taskContextsResponse({ found: ["epic-a", "epic-b"], localHomed: [] }),
      );
      renderMenu(false);

      expect(screen.queryByRole("menuitem", { name: "Labels" })).toBeNull();
      expect(screen.queryByText("Tab appearance")).toBeNull();
    });

    // Hosts can disagree about a task (whether it is local-homed, who can
    // edit it), so only the host this tab's own lookup asks may stand in for it.
    it("ignores a batch cached for another host", () => {
      queryClient.setQueryData(
        stripBatchKeyOnHost("host-2", "user-1"),
        taskContextsResponse({ found: ["epic-a", "epic-b"], localHomed: [] }),
      );
      renderMenu(false);

      expect(screen.queryByRole("menuitem", { name: "Labels" })).toBeNull();
      expect(
        screen.queryByRole("menuitem", { name: "Task appearance" }),
      ).toBeNull();
      expect(
        screen.queryByRole("menuitem", { name: "Add to group" }),
      ).toBeNull();
      expect(screen.queryByText("Tab appearance")).toBeNull();
    });

    it("takes the tab's own host's answer when another host's batch disagrees", () => {
      // Cached first, so a lookup that ignored the host would meet it first.
      queryClient.setQueryData(
        stripBatchKeyOnHost("host-2", "user-1"),
        taskContextsResponse({
          found: ["epic-a", "epic-b"],
          localHomed: ["epic-a"],
        }),
      );
      queryClient.setQueryData(
        stripBatchKeyOnHost("host-1", "user-1"),
        taskContextsResponse({ found: ["epic-a", "epic-b"], localHomed: [] }),
      );
      renderMenu(false);

      expect(screen.getByRole("menuitem", { name: "Labels" })).toBeTruthy();
      expect(screen.queryByText("Tab appearance")).toBeNull();
    });

    it("stands in with nothing while the client has no active host", () => {
      activeHostId.mockReturnValue(null);
      queryClient.setQueryData(
        stripBatchKey("user-1"),
        taskContextsResponse({ found: ["epic-a", "epic-b"], localHomed: [] }),
      );
      renderMenu(false);

      expect(screen.queryByRole("menuitem", { name: "Labels" })).toBeNull();
      expect(screen.queryByText("Tab appearance")).toBeNull();
    });
  });

  it("shows the appearance submenu and stores a color and manual icon", () => {
    renderMenu(false);
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
    renderMenu(false);
    fireEvent.click(screen.getByText("Tab appearance"));
    fireEvent.change(screen.getByLabelText("Custom tab color"), {
      target: { value: "#123456" },
    });

    expect(useTabsStore.getState().customizations?.["epic:tab-a"]?.color).toBe(
      "#123456",
    );
  });

  it("shows a grouped tab's group colour on disabled swatches, with the group's name and a way to edit it, and keeps the icon editable", () => {
    useTabsStore.setState({
      customizations: {
        "epic:tab-a": { color: "#fdd663", icon: null, groupId: "existing" },
      },
    });
    renderMenu(true);
    fireEvent.click(screen.getByText("Tab appearance"));

    const green = screen.getByRole("menuitemradio", { name: "Green" });
    expect(green.getAttribute("aria-checked")).toBe("true");
    expect(
      screen
        .getAllByRole("menuitemradio")
        .every((swatch) => swatch.matches(":disabled")),
    ).toBe(true);
    expect(
      screen.getByText("Follows the group Existing. Change it on the group."),
    ).toBeTruthy();
    expect(
      screen.getByRole("textbox", { name: "Tab icon" }).matches(":disabled"),
    ).toBe(false);
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit group…" }));

    // The menu only asks: the strip opens it once the menu has closed.
    expect(requestedGroup()).toBe("existing");
    expect(useGroupEditorStore.getState().anchorId).toBeNull();
  });

  it("locks an organized task's swatches to its group's colour, keeping its own cloud colour, and offers Edit group", async () => {
    const view: OrganizationView = {
      catalog: [],
      groups: {
        version: "0",
        groups: [
          {
            groupId: "existing",
            name: "Existing",
            color: "#81c995",
            position: 0,
          },
        ],
        memberships: [{ taskId: "epic-a", groupId: "existing", position: 0 }],
      },
      appearances: [
        { taskId: "epic-a", version: "0", color: "#fdd663", icon: "AB" },
      ],
      taskLabels: {},
      ready: true,
      authenticationRequired: false,
      pending: [],
      failures: [],
    };
    const organization = organizationFixture(view);
    const command = vi.spyOn(organization, "command");
    organizationState.organization = organization;
    organizationState.loadTaskContext.mockResolvedValue({
      tasksById: new Map([["epic-a", remoteTask()]]),
      localHomedTaskIds: new Set(),
    });
    renderMenu(true);

    fireEvent.click(await screen.findByText("Task appearance"));

    const green = screen.getByRole("button", { name: "Green" });
    expect(green.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen
        .getAllByRole("button", {
          name: /^(Default|Gray|Blue|Red|Yellow|Green|Pink|Purple|Cyan|Orange)$/,
        })
        .every((swatch) => swatch.matches(":disabled")),
    ).toBe(true);
    expect(
      screen.getByText("Follows the group Existing. Change it on the group."),
    ).toBeTruthy();
    expect(screen.getByLabelText("Icon").matches(":disabled")).toBe(false);
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit group…" }));
    expect(requestedGroup()).toBe("existing");
    expect(command).not.toHaveBeenCalled();
  });

  it("offers no Edit group while the group has no header or chip to open its editor on", () => {
    useTabsStore.setState({
      customizations: {
        "epic:tab-a": { color: null, icon: null, groupId: "existing" },
      },
    });
    renderMenu(false);
    fireEvent.click(screen.getByText("Tab appearance"));

    expect(
      screen.getByText("Follows the group Existing. Change it on the group."),
    ).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Edit group…" })).toBeNull();
  });

  it("offers an ungrouped tab its own colours", () => {
    renderMenu(false);
    fireEvent.click(screen.getByText("Tab appearance"));

    expect(screen.queryByText(/Follows the group/)).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Edit group…" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Blue" }));
    expect(useTabsStore.getState().customizations?.["epic:tab-a"]?.color).toBe(
      "#8ab4f8",
    );
  });

  it("creates a group and supports removing the tab from it", () => {
    renderMenu(false);
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
    renderMenu(false);
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

  it("closes a group's editor with its chip, so the chip does not come back with it open", () => {
    const group = { name: "Alpha", color: "#8ab4f8", collapsed: false };
    const chip = (
      <TabGroupChip groupId="group" group={group} onClose={() => undefined} />
    );
    const view = render(chip);
    fireEvent.contextMenu(
      screen.getByRole("button", { name: /Alpha: collapse group/ }),
    );
    expect(screen.getByRole("textbox", { name: "Group name" })).toBeTruthy();

    view.unmount();
    render(chip);

    expect(screen.queryByRole("textbox", { name: "Group name" })).toBeNull();
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
