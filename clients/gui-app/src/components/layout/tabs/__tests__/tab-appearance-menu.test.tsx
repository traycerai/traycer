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
import { useSyncExternalStore } from "react";
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
  readonly listeners: Set<() => void>;
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
  listeners: new Set(),
  loadTaskContext: vi.fn<() => Promise<GetTaskContextsResponse>>(),
}));
vi.mock("@/hooks/organization/organization-context", async (load) => ({
  ...(await load<typeof import("@/hooks/organization/organization-context")>()),
  useOrganization: () =>
    useSyncExternalStore(
      (listener) => {
        organizationState.listeners.add(listener);
        return () => organizationState.listeners.delete(listener);
      },
      () => organizationState.organization,
    ),
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

const WORK_GROUP = {
  groupId: "work",
  name: "Work",
  color: "#81c995",
  position: 0,
} as const;

/** The account's view: it has a group, and nothing yet for the task. */
function accountView(
  memberships: OrganizationView["groups"]["memberships"],
): OrganizationView {
  return {
    catalog: [],
    groups: { version: "0", groups: [WORK_GROUP], memberships },
    appearances: [],
    taskLabels: {},
    ready: true,
    authenticationRequired: false,
    pending: [],
    failures: [],
  };
}

function organizationFixture(
  view: OrganizationView | undefined,
): OrganizationContextValue {
  return {
    client: organizationClient,
    supported: true,
    hostSupport: true,
    userId: "user-1",
    view,
    register: () => () => undefined,
    command: () => Promise.resolve(undefined),
    refresh: () => Promise.resolve(undefined),
    openDialog: vi.fn(),
  };
}

/** What the Labels item asks the Labels window to allow, once clicked. */
function labelsCanEdit(): boolean {
  const organization = organizationState.organization;
  if (organization === null) throw new Error("no organization fixture");
  fireEvent.click(screen.getByRole("menuitem", { name: "Labels" }));
  const opened = vi.mocked(organization.openDialog).mock.calls.at(-1)?.[0];
  if (opened?.kind !== "labels")
    throw new Error("Labels did not open the Labels window");
  return opened.canEdit;
}

/** The provider publishing a new context value, as it does when its view loads. */
function publishOrganization(next: OrganizationContextValue): void {
  act(() => {
    organizationState.organization = next;
    for (const listener of organizationState.listeners) listener();
  });
}

function remoteTask(epicId: string, createdBy: string): ListTaskLight {
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
        createdBy,
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

/** Tasks the signed-in account (`user-1`) created, which it may label. */
function taskContextsResponse(resolutions: {
  readonly found: readonly string[];
  readonly localHomed: readonly string[];
}): GetTaskContextsResponse {
  const tasks: GetTaskContextsResponse["tasks"] = {};
  for (const epicId of resolutions.found) {
    tasks[epicId] = { status: "found", task: remoteTask(epicId, "user-1") };
  }
  return { tasks, localHomedTaskIds: [...resolutions.localHomed] };
}

/** Tasks someone else created and gave this account no editing role on. */
function sharedTaskContextsResponse(
  found: readonly string[],
): GetTaskContextsResponse {
  const tasks: GetTaskContextsResponse["tasks"] = {};
  for (const epicId of found) {
    tasks[epicId] = {
      status: "found",
      task: remoteTask(epicId, "someone-else"),
    };
  }
  return { tasks, localHomedTaskIds: [] };
}

/** The menu's rows that every task tab gets, whatever its lookup says. */
function expectAccountMenu(): void {
  expect(screen.getByRole("menuitem", { name: "Labels" })).toBeTruthy();
  expect(
    screen.getByRole("menuitem", { name: "Task appearance" }),
  ).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Add to group" })).toBeTruthy();
  expect(screen.queryByText("Tab appearance")).toBeNull();
  expect(screen.queryByRole("menuitem", { name: /Retry/i })).toBeNull();
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
    organizationState.organization = organizationFixture(accountView([]));
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

  describe("the account's groups, whatever the task's lookup says", () => {
    const stripBatchKey = (userId: string) =>
      hostQueryKeys.epicTaskContexts("host-1", userId, ["epic-a", "epic-b"]);

    beforeEach(() => {
      activeHostId.mockReturnValue("host-1");
      organizationState.organization = organizationFixture(accountView([]));
      organizationState.loadTaskContext.mockReturnValue(
        new Promise<GetTaskContextsResponse>(() => undefined),
      );
    });

    async function chooseWorkGroup(): Promise<HTMLElement> {
      fireEvent.click(screen.getByRole("menuitem", { name: "Add to group" }));
      return screen.findByRole("menuitem", { name: "Work" });
    }

    // The batch is a different cache entry from the tab's own lookup. A render
    // while the own lookup is pending (here the organization view loading)
    // must find it; the compiled memo kept the stand-in empty until the own
    // lookup answered.
    it("picks up a batch that lands while the tab's own lookup is still pending", () => {
      organizationState.organization = organizationFixture(undefined);
      renderMenu(false);
      expect(screen.queryByRole("menuitem", { name: "Labels" })).toBeNull();

      act(() => {
        queryClient.setQueryData(
          stripBatchKey("user-1"),
          taskContextsResponse({ found: ["epic-a", "epic-b"], localHomed: [] }),
        );
      });
      publishOrganization(
        organizationFixture({
          catalog: [],
          groups: { version: "0", groups: [], memberships: [] },
          appearances: [],
          taskLabels: {},
          ready: true,
          authenticationRequired: false,
          pending: [],
          failures: [],
        }),
      );

      expect(screen.getByRole("menuitem", { name: "Labels" })).toBeTruthy();
    });

    it("offers the account's groups, enabled, to a task whose lookup says it is still local-homed", async () => {
      queryClient.setQueryData(
        stripBatchKey("user-1"),
        taskContextsResponse({
          found: ["epic-a", "epic-b"],
          localHomed: ["epic-a"],
        }),
      );
      renderMenu(false);

      expectAccountMenu();
      const work = await chooseWorkGroup();
      expect(work.getAttribute("aria-disabled")).toBeNull();
      expect(
        screen
          .getByRole("menuitem", { name: "New group…" })
          .getAttribute("aria-disabled"),
      ).toBeNull();
    });

    it("moves a task with no cloud appearance yet into the chosen group", async () => {
      // The account's view has no appearance row for this task: the menu once
      // waited for one before it let the task join a group.
      const organization = organizationFixture(accountView([]));
      const command = vi.spyOn(organization, "command");
      organizationState.organization = organization;
      queryClient.setQueryData(
        stripBatchKey("user-1"),
        taskContextsResponse({
          found: ["epic-a", "epic-b"],
          localHomed: ["epic-a"],
        }),
      );
      renderMenu(false);

      fireEvent.click(await chooseWorkGroup());

      expect(command).toHaveBeenCalledExactlyOnceWith({
        kind: "groups",
        operations: [
          {
            operation: "moveTask",
            taskId: "epic-a",
            groupId: "work",
            position: 0,
          },
        ],
      });
    });

    it("takes Task appearance under the same edit gate as Labels: both are disabled while the host cannot take organization commands, both enabled when it can", () => {
      queryClient.setQueryData(
        stripBatchKey("user-1"),
        taskContextsResponse({ found: ["epic-a", "epic-b"], localHomed: [] }),
      );
      const rowIsDisabled = (name: string): boolean =>
        screen.getByRole("menuitem", { name }).getAttribute("aria-disabled") ===
        "true";

      // The view is present, so the rows stay on screen with the account's
      // cached groups; only the right to change them is withdrawn.
      organizationState.organization = {
        ...organizationFixture(accountView([])),
        supported: false,
      };
      renderMenu(false);
      expect(rowIsDisabled("Labels")).toBe(true);
      expect(rowIsDisabled("Task appearance")).toBe(true);

      publishOrganization(organizationFixture(accountView([])));
      expect(rowIsDisabled("Labels")).toBe(false);
      expect(rowIsDisabled("Task appearance")).toBe(false);
    });

    it("offers the same menu to a task whose lookup has not answered", () => {
      renderMenu(false);

      expectAccountMenu();
    });

    it("shows the organization controls at once from a batch another surface cached", () => {
      queryClient.setQueryData(
        stripBatchKey("user-1"),
        taskContextsResponse({ found: ["epic-a", "epic-b"], localHomed: [] }),
      );
      renderMenu(false);

      expectAccountMenu();
      expect(organizationState.loadTaskContext).toHaveBeenCalledTimes(1);
    });

    it("takes a task's own answer over the cached batch's when it comes: local-homed means the account's own task", async () => {
      queryClient.setQueryData(
        stripBatchKey("user-1"),
        sharedTaskContextsResponse(["epic-a", "epic-b"]),
      );
      let answerOwnLookup: (response: GetTaskContextsResponse) => void = () =>
        undefined;
      const ownLookup = new Promise<GetTaskContextsResponse>((resolve) => {
        answerOwnLookup = resolve;
      });
      organizationState.loadTaskContext.mockReturnValue(ownLookup);
      renderMenu(false);
      expect(labelsCanEdit()).toBe(false);

      await act(async () => {
        answerOwnLookup(
          taskContextsResponse({ found: ["epic-a"], localHomed: ["epic-a"] }),
        );
        await ownLookup;
      });

      await waitFor(() => expect(labelsCanEdit()).toBe(true));
      expectAccountMenu();
    });

    // A task deleted (or no longer visible) since the strip's batch was cached
    // must not keep editing rights once the tab's own, fresher lookup says so.
    // It keeps its menu: the groups are the account's, not the task's.
    const unresolvedResolutions: readonly TaskContextResolution[] = [
      { status: "confirmed-absent" },
      { status: "unknown", reason: "not-found-or-not-permitted" },
    ];
    it.each(unresolvedResolutions)(
      "keeps the menu but drops the stand-in's editing rights when the tab's own lookup settles as $status",
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
        expect(labelsCanEdit()).toBe(true);

        await act(async () => {
          answerOwnLookup({
            tasks: { "epic-a": resolution },
            localHomedTaskIds: [],
          });
          await ownLookup;
        });

        await waitFor(() => expect(labelsCanEdit()).toBe(false));
        expectAccountMenu();
      },
    );

    it.each(unresolvedResolutions)(
      "does not bring the stand-in's editing rights back while the tab's own lookup refetches after settling as $status",
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
        await waitFor(() => expect(labelsCanEdit()).toBe(false));
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
        expect(labelsCanEdit()).toBe(false);
        expectAccountMenu();
      },
    );

    it("keeps the menu, view-only, when the cached batch did not resolve the task", () => {
      queryClient.setQueryData(
        stripBatchKey("user-1"),
        taskContextsResponse({ found: ["epic-b"], localHomed: [] }),
      );
      renderMenu(false);

      expectAccountMenu();
      expect(labelsCanEdit()).toBe(false);
    });

    it("does not let a batch cached for another account grant editing rights", () => {
      queryClient.setQueryData(
        stripBatchKey("user-2"),
        taskContextsResponse({ found: ["epic-a", "epic-b"], localHomed: [] }),
      );
      renderMenu(false);

      expectAccountMenu();
      expect(labelsCanEdit()).toBe(false);
    });

    // Hosts can disagree about a task (whether it is local-homed, who can
    // edit it), so only the host this tab's own lookup asks may stand in for it.
    it("does not let a batch cached for another host grant editing rights", () => {
      queryClient.setQueryData(
        hostQueryKeys.epicTaskContexts("host-2", "user-1", [
          "epic-a",
          "epic-b",
        ]),
        taskContextsResponse({ found: ["epic-a", "epic-b"], localHomed: [] }),
      );
      renderMenu(false);

      expectAccountMenu();
      expect(labelsCanEdit()).toBe(false);
    });

    it("takes the tab's own host's answer when another host's batch disagrees", () => {
      // Cached first, so a lookup that ignored the host would meet it first.
      queryClient.setQueryData(
        hostQueryKeys.epicTaskContexts("host-2", "user-1", [
          "epic-a",
          "epic-b",
        ]),
        taskContextsResponse({
          found: ["epic-a", "epic-b"],
          localHomed: ["epic-a"],
        }),
      );
      queryClient.setQueryData(
        stripBatchKey("user-1"),
        sharedTaskContextsResponse(["epic-a", "epic-b"]),
      );
      renderMenu(false);

      expectAccountMenu();
      expect(labelsCanEdit()).toBe(false);
    });

    it("stands in with nothing while the client has no active host", () => {
      activeHostId.mockReturnValue(null);
      queryClient.setQueryData(
        stripBatchKey("user-1"),
        taskContextsResponse({ found: ["epic-a", "epic-b"], localHomed: [] }),
      );
      renderMenu(false);

      expectAccountMenu();
      expect(labelsCanEdit()).toBe(false);
    });
  });

  describe("the account's group commands from the menu", () => {
    function groupedMenu(): OrganizationContextValue {
      const organization = organizationFixture(
        accountView([{ taskId: "epic-a", groupId: "work", position: 0 }]),
      );
      organizationState.organization = organization;
      organizationState.loadTaskContext.mockResolvedValue(
        taskContextsResponse({ found: ["epic-a"], localHomed: [] }),
      );
      return organization;
    }

    it("removes a grouped task from its group", async () => {
      const command = vi.spyOn(groupedMenu(), "command");
      renderMenu(false);

      expect(
        await screen.findByRole("menuitem", { name: "Move to group" }),
      ).toBeTruthy();
      fireEvent.click(
        screen.getByRole("menuitem", { name: "Remove from group" }),
      );

      expect(command).toHaveBeenCalledExactlyOnceWith({
        kind: "groups",
        operations: [{ operation: "removeTask", taskId: "epic-a" }],
      });
    });

    it("opens the new-group window for the task", async () => {
      const organization = groupedMenu();
      renderMenu(false);

      fireEvent.click(
        await screen.findByRole("menuitem", { name: "Move to group" }),
      );
      fireEvent.click(
        await screen.findByRole("menuitem", { name: "New group…" }),
      );

      expect(organization.openDialog).toHaveBeenCalledExactlyOnceWith({
        kind: "new-group",
        taskId: "epic-a",
      });
    });
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
    organizationState.loadTaskContext.mockResolvedValue(
      taskContextsResponse({ found: ["epic-a"], localHomed: [] }),
    );
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

  it("offers no Edit group while the group has no header or chip to open its editor on", async () => {
    organizationState.organization = organizationFixture({
      ...accountView([{ taskId: "epic-a", groupId: "existing", position: 0 }]),
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
    });
    organizationState.loadTaskContext.mockResolvedValue(
      taskContextsResponse({ found: ["epic-a"], localHomed: [] }),
    );
    renderMenu(false);

    fireEvent.click(await screen.findByText("Task appearance"));

    expect(
      await screen.findByText(
        "Follows the group Existing. Change it on the group.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Edit group…" })).toBeNull();
  });

  describe("a group's chip", () => {
    const group = {
      name: "Alpha",
      color: "#8ab4f8",
      collapsed: false,
    } as const;

    beforeEach(() => {
      useTabsStore.setState({
        groups: { group },
        customizations: {
          "epic:tab-a": { color: null, icon: null, groupId: "group" },
        },
      });
    });

    /** The account has the group, so the editor can change it. */
    function accountHasTheGroup(): OrganizationContextValue {
      const organization = organizationFixture({
        ...accountView([]),
        groups: {
          version: "0",
          groups: [
            { groupId: "group", name: "Alpha", color: "#8ab4f8", position: 0 },
          ],
          memberships: [{ taskId: "epic-a", groupId: "group", position: 0 }],
        },
      });
      organizationState.organization = organization;
      return organization;
    }

    function openEditor(): void {
      render(<TabGroupChip groupId="group" group={group} onClose={vi.fn()} />);
      fireEvent.contextMenu(
        screen.getByRole("button", { name: /Alpha: collapse group/ }),
      );
    }

    it("folds and unfolds the group in this window only", () => {
      const organization = accountHasTheGroup();
      const command = vi.spyOn(organization, "command");
      render(<TabGroupChip groupId="group" group={group} onClose={vi.fn()} />);

      fireEvent.click(
        screen.getByRole("button", { name: /Alpha: collapse group/ }),
      );

      expect(useTabsStore.getState().groups?.group.collapsed).toBe(true);
      expect(command).not.toHaveBeenCalled();
    });

    it("renames the account's group through the account, not in a local copy", () => {
      const command = vi.spyOn(accountHasTheGroup(), "command");
      openEditor();

      const name = screen.getByRole("textbox", { name: "Group name" });
      fireEvent.change(name, { target: { value: "Renamed" } });
      fireEvent.keyDown(name, { key: "Enter" });

      expect(command).toHaveBeenCalledExactlyOnceWith({
        kind: "groups",
        operations: [
          {
            operation: "update",
            groupId: "group",
            name: "Renamed",
            color: "#8ab4f8",
          },
        ],
      });
      expect(useTabsStore.getState().groups?.group.name).toBe("Alpha");
    });

    it("recolours the account's group through the account, from the custom picker too", () => {
      const command = vi.spyOn(accountHasTheGroup(), "command");
      openEditor();

      fireEvent.change(screen.getByLabelText("Custom tab color"), {
        target: { value: "#123456" },
      });

      expect(command).toHaveBeenCalledExactlyOnceWith({
        kind: "groups",
        operations: [
          {
            operation: "update",
            groupId: "group",
            name: "Alpha",
            color: "#123456",
          },
        ],
      });
      expect(useTabsStore.getState().groups?.group.color).toBe("#8ab4f8");
    });

    it("deletes the account's group with Ungroup", () => {
      const command = vi.spyOn(accountHasTheGroup(), "command");
      openEditor();

      fireEvent.click(screen.getByRole("button", { name: "Ungroup" }));

      expect(command).toHaveBeenCalledExactlyOnceWith({
        kind: "groups",
        operations: [{ operation: "delete", groupId: "group" }],
      });
    });

    it("opens a new tab in the group, and closes the group, from the editor", () => {
      accountHasTheGroup();
      const close = vi.fn();
      render(<TabGroupChip groupId="group" group={group} onClose={close} />);
      fireEvent.contextMenu(
        screen.getByRole("button", { name: /Alpha: collapse group/ }),
      );

      fireEvent.click(screen.getByRole("button", { name: "New tab in group" }));
      expect(navigation.open).toHaveBeenCalled();
      fireEvent.contextMenu(
        screen.getByRole("button", { name: /Alpha: collapse group/ }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Close group" }));

      expect(close).toHaveBeenCalledWith("group");
    });

    it("leaves a group the account does not have exactly as it is: nothing to edit, nothing to ungroup", () => {
      const organization = organizationFixture(accountView([]));
      const command = vi.spyOn(organization, "command");
      organizationState.organization = organization;
      openEditor();

      const name = screen.getByRole("textbox", { name: "Group name" });
      expect(name.matches(":disabled")).toBe(true);
      expect(
        screen
          .getAllByRole("button", { name: /^(Blue|Green|Red)$/ })
          .every((swatch) => swatch.matches(":disabled")),
      ).toBe(true);
      expect(screen.queryByRole("button", { name: "Ungroup" })).toBeNull();
      expect(command).not.toHaveBeenCalled();
      expect(useTabsStore.getState().groups?.group).toEqual(group);
    });
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
});
