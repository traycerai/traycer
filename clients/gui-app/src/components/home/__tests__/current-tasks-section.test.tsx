import type { WorktreeHostEntryV12 } from "@traycer/protocol/host/worktree-schemas";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import type { HistoryNewWindowFlow } from "@/components/epics/use-history-open-in-new-window";
import type { CurrentTaskGroups } from "@/lib/home/current-tasks";
import type { ActivityFleetCoverage } from "@/stores/agent-activity-store";

const testState = vi.hoisted(() => ({
  groups: { inProgress: [], pinned: [], open: [] } as CurrentTaskGroups,
  isPending: false,
  pinsComplete: true,
  activityCoverage: "fleet" as ActivityFleetCoverage,
  openItem: vi.fn<(item: HistoryItem) => void>(),
  openHistory: vi.fn(),
  setPinnedMutate: vi.fn<(variables: SetPinnedVariables) => void>(),
  pendingPinIds: new Set<string>(),
  worktreesByEpicId: new Map<string, readonly WorktreeHostEntryV12[]>(),
  openInBackground:
    vi.fn<(epicId: string, title: string | undefined) => void>(),
  requestOpenInNewWindow: vi.fn<(item: HistoryItem) => void>(),
  isNewWindowAvailable: false,
}));

// Stands in for a host's client: what a row needs from one is only that the
// worktree read is handed the client of the host it asked for.
interface FakeHostClient {
  readonly hostId: string | null;
}

const hostClients = vi.hoisted(() => {
  const clientsByHostId = new Map<string | null, FakeHostClient>();
  return {
    askedHostIds: [] as Array<string | null>,
    worktreeReads: [] as Array<{
      readonly client: FakeHostClient | null;
      readonly epicIds: readonly string[];
    }>,
    clientFor: (hostId: string | null): FakeHostClient => {
      const existing = clientsByHostId.get(hostId);
      if (existing !== undefined) return existing;
      const created: FakeHostClient = { hostId };
      clientsByHostId.set(hostId, created);
      return created;
    },
    reset: (): void => {
      clientsByHostId.clear();
      hostClients.askedHostIds.length = 0;
      hostClients.worktreeReads.length = 0;
    },
  };
});

const pinSupport = vi.hoisted(() =>
  vi.fn<(hostId: string | null) => boolean>(),
);

interface SetPinnedVariables {
  readonly epicId: string;
  readonly pinned: boolean;
  readonly isLocalHome: boolean;
  readonly hostId: string | null;
}

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "dark" }),
}));

vi.mock("@/hooks/notifications/use-host-notification-indicators-query", () => ({
  useHostNotificationIndicators: () => ({
    data: { epics: {}, chats: {} },
    isPending: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
  }),
}));

vi.mock("@/hooks/home/use-current-tasks", () => ({
  useCurrentTasks: () => ({
    groups: testState.groups,
    isPending: testState.isPending,
    pinsComplete: testState.pinsComplete,
    activityCoverage: testState.activityCoverage,
  }),
}));

vi.mock("@/components/epics/use-history-open-item", () => ({
  useHistoryOpenItem: () => testState.openItem,
}));

vi.mock("@/hooks/epic/use-epic-set-pinned-mutation", () => ({
  useEpicSetPinned: () => ({ mutate: testState.setPinnedMutate }),
  usePendingSetPinnedEpicIds: () => testState.pendingPinIds,
}));

vi.mock("@/hooks/epic/use-epic-pin-local-home-support", () => ({
  useEpicPinLocalHomeSupported: (hostId: string | null) => pinSupport(hostId),
}));

vi.mock("@/hooks/epic/use-epic-activity-status", () => ({
  useEpicActivityStatus: () => "idle",
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));

// A row reads its own task's worktrees from the host that owns the task. Both
// hooks resolve a host runtime this fixture has no provider for, so the client
// lookup hands out one recognisable fake per host id and the worktree read
// records which client and task ids it was asked about.
vi.mock("@/hooks/host/use-host-client-for-host-id", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/host/use-host-client-for-host-id")
    >();
  return {
    ...actual,
    useHostClientForHostId: (hostId: string | null): FakeHostClient => {
      hostClients.askedHostIds.push(hostId);
      return hostClients.clientFor(hostId);
    },
  };
});

vi.mock("@/hooks/worktree/use-task-worktree-metadata-query", () => ({
  useTaskWorktreeMetadataForClient: (
    client: FakeHostClient | null,
    epicIds: readonly string[],
  ) => {
    hostClients.worktreeReads.push({ client, epicIds });
    return {
      worktreesByEpicId: testState.worktreesByEpicId,
      isFetching: false,
      error: null,
    };
  },
}));

// The real flow reads the router and the desktop windows bridge, neither of
// which this fixture mounts; what a row needs from it is availability and the
// request to open a task in another window.
vi.mock("@/components/epics/use-history-open-in-new-window", () => ({
  useHistoryOpenInNewWindowFlow: (): HistoryNewWindowFlow => ({
    isAvailable: testState.isNewWindowAvailable,
    requestOpen: testState.requestOpenInNewWindow,
    epicFlow: {
      isAvailable: testState.isNewWindowAvailable,
      pendingMove: null,
      requestOpenInNewWindow: () => undefined,
      waitForSync: () => undefined,
      cancelMove: () => undefined,
      discardAndMove: () => undefined,
    },
  }),
}));

vi.mock("@/lib/commands/actions/open-epic-in-background", () => ({
  openEpicInBackground: testState.openInBackground,
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openHistory: testState.openHistory }),
}));

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { OrganizationView } from "@traycer/protocol/host/organization/contracts";
import type { TaskLabel } from "@traycer/protocol/host/organization/schemas";
import { CurrentTasksSection } from "@/components/home/current-tasks-section";
import { holdEpicBatchDelete } from "@/hooks/epic/__tests__/hold-epic-batch-delete";
import { tooltipTextNear } from "@/components/ui/__tests__/tooltip-probe";
import type { OrganizationDialog } from "@/components/organization/organization-dialogs";
import {
  OrganizationContext,
  type OrganizationContextValue,
} from "@/hooks/organization/organization-context";
import { DEFAULT_HISTORY_SEARCH } from "@/lib/history-search";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useHistorySearchStore } from "@/stores/home/history-search-store";

const CAPTION =
  "Tasks in progress, pinned, or open in a tab. Everything else is in History.";
const COVERAGE_NOTICE = "Can't check everything that's running right now";
const PINS_UNAVAILABLE_NOTICE = "Can't load your pinned tasks right now.";
const PINS_PARTIAL_NOTICE = "Some pinned tasks couldn't load.";

function task(id: string, overrides: Partial<HistoryItem>): HistoryItem {
  return {
    id,
    epicId: `epic-${id}`,
    taskType: "epic",
    title: `Task ${id}`,
    initialUserPrompt: "",
    updatedAtMs: 1_700_000_000_000,
    updatedLabel: "about 2 hours ago",
    updatedBucket: "today",
    linkedRepos: [],
    linkedWorkspaces: [],
    chatHostIds: null,
    pullRequestNumbers: [],
    worktreeBranches: [],
    worktreePaths: [],
    ownership: "mine",
    permissionRole: "owner",
    isPinned: false,
    ...overrides,
  };
}

function tasks(prefix: string, count: number): HistoryItem[] {
  return Array.from({ length: count }, (_, index) =>
    task(`${prefix}${index + 1}`, {}),
  );
}

function setGroups(groups: Partial<CurrentTaskGroups>): void {
  testState.groups = { inProgress: [], pinned: [], open: [], ...groups };
}

// A row asks the mutation cache whether its task is being deleted (from
// History, which this page sits beside), so the section mounts inside a client.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

function Providers(props: { readonly children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

function renderSection() {
  return render(<CurrentTasksSection />, { wrapper: Providers });
}

const openOrganizationDialog = vi.fn<(dialog: OrganizationDialog) => void>();
const registerOrganizationTasks = vi.fn<
  (key: string, taskIds: readonly string[]) => () => void
>(() => () => undefined);
const organizationClient = new HostClient<HostRpcRegistry>({
  registry: hostRpcRegistry,
  invalidator: { invalidateHostScope: () => undefined },
  messenger: new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "request-1",
    handlers: {},
  }),
});

function organizationView(
  overrides: Partial<OrganizationView>,
): OrganizationView {
  return {
    catalog: [],
    groups: { version: "0", groups: [], memberships: [] },
    appearances: [],
    taskLabels: {},
    ready: true,
    authenticationRequired: false,
    pending: [],
    failures: [],
    ...overrides,
  };
}

function taskLabel(name: string): TaskLabel {
  return {
    ownerId: "user-1",
    labelId: `label-${name}`,
    assignmentId: `assignment-${name}`,
    kind: "custom",
    systemKey: null,
    name,
    color: "#8ab4f8",
    version: "0",
  };
}

// The start page sits under the same organization provider as History, so a
// supported context is what makes labels, groups and the organization menu
// appear on a row.
function renderSectionWithOrganization(view: OrganizationView) {
  const organization: OrganizationContextValue = {
    client: organizationClient,
    supported: true,
    userId: "user-1",
    view,
    register: registerOrganizationTasks,
    command: () => Promise.resolve(undefined),
    refresh: () => Promise.resolve(undefined),
    openDialog: openOrganizationDialog,
  };
  return render(
    <OrganizationContext.Provider value={organization}>
      <CurrentTasksSection />
    </OrganizationContext.Provider>,
    { wrapper: Providers },
  );
}

function taskWorktree(epicId: string): WorktreeHostEntryV12 {
  return {
    worktreePath: `/worktrees/app/${epicId}`,
    repoLabel: "acme/app",
    repoIdentifier: { owner: "acme", repo: "app" },
    branch: "feature/current-tasks",
    inUse: false,
    uncommittedCount: 0,
    gitRemovable: true,
    scripts: null,
    lastActivityAt: null,
    owners: [{ epicId, ownerKind: "chat", ownerId: "chat-1", updatedAt: 1 }],
    branchStatus: { ahead: 1, behind: 0, mergedIntoDefault: false },
    createdAt: null,
    prState: "open",
    prNumber: 84,
    prUrl: "https://github.com/acme/app/pull/84",
    mergedHeadShaMatches: false,
    submodules: [],
    atBaseCommit: false,
  };
}

function rowIds(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-current-task-id]"),
  ).map((row) => row.dataset.currentTaskId ?? "");
}

function rowButton(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(
    `[data-current-task-id="${id}"]`,
  );
  if (row === null) throw new Error(`no row for ${id}`);
  return row;
}

function group(title: string): HTMLElement {
  return screen.getByRole("region", { name: new RegExp(`^${title}`) });
}

describe("<CurrentTasksSection />", () => {
  beforeEach(() => {
    setGroups({});
    testState.isPending = false;
    testState.pinsComplete = true;
    testState.activityCoverage = "fleet";
    testState.openItem.mockReset();
    testState.openHistory.mockReset();
    testState.setPinnedMutate.mockReset();
    testState.pendingPinIds = new Set();
    testState.worktreesByEpicId = new Map();
    hostClients.reset();
    testState.openInBackground.mockReset();
    testState.requestOpenInNewWindow.mockReset();
    testState.isNewWindowAvailable = false;
    openOrganizationDialog.mockReset();
    registerOrganizationTasks.mockClear();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    pinSupport.mockReset();
    pinSupport.mockReturnValue(true);
    useAuthStore.setState({ status: "signed-in" });
    useHistorySearchStore.setState({ search: DEFAULT_HISTORY_SEARCH });
    queryClient.clear();
  });

  afterEach(() => {
    cleanup();
    useAuthStore.setState({ status: "signed-out" });
    useHistorySearchStore.setState({ search: DEFAULT_HISTORY_SEARCH });
  });

  describe("content", () => {
    it("renders the heading, View history and the three groups", () => {
      setGroups({
        inProgress: [task("a", {})],
        pinned: [task("b", { isPinned: true })],
        open: [task("c", {})],
      });
      renderSection();

      const section = screen.getByTestId("current-tasks-section");
      expect(
        within(section).getByRole("heading", { name: "Current tasks" }),
      ).not.toBeNull();
      expect(within(section).queryByText(CAPTION)).toBeNull();
      expect(
        within(section).getByRole("button", { name: /^View history/ }),
      ).not.toBeNull();
      expect(group("In progress")).not.toBeNull();
      expect(group("Pinned")).not.toBeNull();
      expect(group("Open")).not.toBeNull();
      expect(rowIds()).toEqual(["a", "b", "c"]);
    });

    it("opens History from View history", () => {
      renderSection();

      // Confirmed-empty also carries its own View history; the header's is first.
      fireEvent.click(
        screen.getAllByRole("button", { name: /^View history/ })[0],
      );

      expect(testState.openHistory).toHaveBeenCalledTimes(1);
    });

    it("omits empty groups", () => {
      setGroups({ pinned: [task("b", { isPinned: true })] });
      renderSection();

      expect(screen.queryByRole("region", { name: /^In progress/ })).toBeNull();
      expect(screen.queryByRole("region", { name: /^Open/ })).toBeNull();
      expect(group("Pinned")).not.toBeNull();
    });

    it("opens a task from its row target", () => {
      const item = task("a", {});
      setGroups({ open: [item] });
      renderSection();

      fireEvent.click(screen.getByRole("button", { name: "Open task Task a" }));

      expect(testState.openItem).toHaveBeenCalledWith(item);
    });

    it("offers only open and pin: no rename, delete, sweep or select", () => {
      setGroups({ open: [task("a", {})] });
      renderSection();

      expect(
        screen.getByRole("button", { name: "Open task Task a" }),
      ).not.toBeNull();
      expect(screen.getByTestId("epics-list-row-pin")).not.toBeNull();
      expect(screen.queryByTestId("epics-list-row-rename")).toBeNull();
      expect(screen.queryByTestId("epics-list-row-delete")).toBeNull();
      expect(screen.queryByTestId("epics-list-row-sweep")).toBeNull();
      expect(screen.queryByTestId("epics-list-row-sweep-disabled")).toBeNull();
      expect(
        screen.queryByRole("button", { name: /select|delete|rename/i }),
      ).toBeNull();
    });

    it("pins and unpins through the shared mutation", () => {
      setGroups({
        pinned: [task("b", { isPinned: true })],
        open: [task("a", {})],
      });
      renderSection();

      fireEvent.click(within(rowItem("a")).getByTestId("epics-list-row-pin"));
      fireEvent.click(within(rowItem("b")).getByTestId("epics-list-row-pin"));

      expect(testState.setPinnedMutate).toHaveBeenNthCalledWith(1, {
        epicId: "epic-a",
        pinned: true,
        isLocalHome: false,
        hostId: null,
      });
      expect(testState.setPinnedMutate).toHaveBeenNthCalledWith(2, {
        epicId: "epic-b",
        pinned: false,
        isLocalHome: false,
        hostId: null,
      });
    });

    it("propagates a local-homed row's isLocalHome to the pin mutation", () => {
      setGroups({ open: [task("a", { isLocalHome: true })] });
      renderSection();

      fireEvent.click(screen.getByTestId("epics-list-row-pin"));

      expect(testState.setPinnedMutate).toHaveBeenCalledWith({
        epicId: "epic-a",
        pinned: true,
        isLocalHome: true,
        hostId: null,
      });
    });

    it("disables the pin control of a task whose pin is in flight", () => {
      testState.pendingPinIds = new Set(["epic-a"]);
      setGroups({ open: [task("a", {})] });
      renderSection();

      const pin = screen.getByTestId("epics-list-row-pin");
      expect(pin instanceof HTMLButtonElement && pin.disabled).toBe(true);
    });

    it("dispatches a pin against the row's owning host", () => {
      setGroups({ open: [task("a", { hostId: "host-b", isLocalHome: true })] });
      renderSection();

      fireEvent.click(screen.getByTestId("epics-list-row-pin"));

      expect(pinSupport).toHaveBeenCalledWith("host-b");
      expect(testState.setPinnedMutate).toHaveBeenCalledWith({
        epicId: "epic-a",
        pinned: true,
        isLocalHome: true,
        hostId: "host-b",
      });
    });

    it("gates a local row on its owning host: unsupported there is aria-disabled and never dispatches", () => {
      pinSupport.mockImplementation((hostId) => hostId !== "host-b");
      setGroups({
        open: [
          task("a", { hostId: "host-b", isLocalHome: true }),
          task("c", { hostId: "host-d", isLocalHome: true }),
        ],
      });
      renderSection();

      const pinA = within(rowItem("a")).getByTestId("epics-list-row-pin");
      const pinC = within(rowItem("c")).getByTestId("epics-list-row-pin");
      expect(pinA.getAttribute("aria-disabled")).toBe("true");
      expect(pinC.getAttribute("aria-disabled")).toBeNull();
      fireEvent.click(pinA);
      expect(testState.setPinnedMutate).not.toHaveBeenCalled();
      fireEvent.click(pinC);
      expect(testState.setPinnedMutate).toHaveBeenCalledTimes(1);
    });
  });

  describe("task organization", () => {
    it("shows a task's group, labels and custom icon on its row", () => {
      setGroups({ open: [task("a", {}), task("b", {})] });
      renderSectionWithOrganization(
        organizationView({
          groups: {
            version: "0",
            groups: [
              {
                groupId: "group-1",
                name: "Backend",
                color: "#445566",
                position: 0,
              },
            ],
            memberships: [
              { taskId: "epic-a", groupId: "group-1", position: 0 },
            ],
          },
          appearances: [
            { taskId: "epic-a", version: "0", color: null, icon: "★" },
          ],
          taskLabels: {
            "epic-a": { labels: [taskLabel("Urgent")], removed: [] },
          },
        }),
      );

      expect(
        within(rowItem("a")).getByRole("button", {
          name: "Task organization: Group: Backend; Label: Urgent",
        }),
      ).not.toBeNull();
      expect(
        within(rowItem("a")).getByLabelText("Custom icon: ★"),
      ).not.toBeNull();
      expect(
        within(rowItem("b")).queryByRole("button", {
          name: /^Task organization/,
        }),
      ).toBeNull();
    });

    it("opens the labels window from a row's label chip", () => {
      setGroups({ open: [task("a", {})] });
      renderSectionWithOrganization(
        organizationView({
          taskLabels: {
            "epic-a": { labels: [taskLabel("Urgent")], removed: [] },
          },
        }),
      );

      fireEvent.click(
        screen.getByRole("button", { name: /^Task organization/ }),
      );

      expect(openOrganizationDialog).toHaveBeenCalledWith({
        kind: "labels",
        taskId: "epic-a",
        canEdit: true,
      });
      expect(testState.openItem).not.toHaveBeenCalled();
    });

    it("lets a viewer read a task's labels but not edit them", () => {
      setGroups({
        open: [task("a", { permissionRole: "viewer", ownership: "shared" })],
      });
      renderSectionWithOrganization(organizationView({}));

      fireEvent.contextMenu(screen.getByTestId("epics-list-row-card"));
      fireEvent.click(screen.getByRole("menuitem", { name: "Labels" }));

      expect(openOrganizationDialog).toHaveBeenCalledWith({
        kind: "labels",
        taskId: "epic-a",
        canEdit: false,
      });
    });
  });

  describe("organization registration", () => {
    // The organization view only carries the tasks some surface registered, and
    // a pinned or running task that is not open is registered by nobody else.
    const registrations = () =>
      registerOrganizationTasks.mock.calls.map(([, taskIds]) => [...taskIds]);
    const registeredTaskIds = () => new Set(registrations().flat());

    it("registers every shown task, a closed pinned one included", () => {
      setGroups({
        inProgress: [task("c", {})],
        pinned: [task("a", { isPinned: true })],
        open: [task("b", {})],
      });
      renderSectionWithOrganization(organizationView({}));

      expect([...registeredTaskIds()].toSorted()).toEqual([
        "epic-a",
        "epic-b",
        "epic-c",
      ]);
    });

    it("registers nothing for local-home, preserved-orphan and phase rows, which have no cloud organization", () => {
      setGroups({
        open: [
          task("a", {}),
          task("l", { isLocalHome: true }),
          task("x", { isPreservedOrphan: true }),
          task("p", { taskType: "phase" }),
        ],
      });
      renderSectionWithOrganization(organizationView({}));

      expect(registrations().filter((taskIds) => taskIds.length > 0)).toEqual([
        ["epic-a"],
      ]);
      expect(
        registrations().filter((taskIds) => taskIds.length === 0),
      ).toHaveLength(3);
    });

    it("registers a row hidden behind 'Show more' only once it is shown", () => {
      setGroups({ open: tasks("o", 7) });
      renderSectionWithOrganization(organizationView({}));

      expect([...registeredTaskIds()].toSorted()).toEqual([
        "epic-o1",
        "epic-o2",
        "epic-o3",
        "epic-o4",
        "epic-o5",
      ]);

      fireEvent.click(screen.getByRole("button", { name: "Show 2 more" }));

      expect(registeredTaskIds().has("epic-o6")).toBe(true);
      expect(registeredTaskIds().has("epic-o7")).toBe(true);
    });
  });

  describe("context menu", () => {
    const rowCard = (id: string) =>
      within(rowItem(id)).getByTestId("epics-list-row-card");

    it("offers the organization actions and both open actions", async () => {
      testState.isNewWindowAvailable = true;
      setGroups({ open: [task("a", {})] });
      renderSectionWithOrganization(organizationView({}));

      fireEvent.contextMenu(rowCard("a"));

      expect(
        await screen.findByRole("menuitem", { name: "Labels" }),
      ).not.toBeNull();
      expect(
        screen.getByRole("menuitem", { name: "Task appearance" }),
      ).not.toBeNull();
      expect(
        screen.getByRole("menuitem", { name: "Add to group" }),
      ).not.toBeNull();
      expect(
        screen.getByRole("menuitem", { name: "Open in Background" }),
      ).not.toBeNull();
      expect(
        screen.getByRole("menuitem", { name: "Open in New Window" }),
      ).not.toBeNull();
    });

    it("still offers Open in Background when the organization is unavailable", async () => {
      setGroups({ open: [task("a", {})] });
      renderSection();

      fireEvent.contextMenu(rowCard("a"));

      expect(
        await screen.findByRole("menuitem", { name: "Open in Background" }),
      ).not.toBeNull();
      expect(screen.queryByRole("menuitem", { name: "Labels" })).toBeNull();
    });

    it("opens the task in a background tab from Open in Background", async () => {
      setGroups({ open: [task("a", {})] });
      renderSection();

      fireEvent.contextMenu(rowCard("a"));
      fireEvent.click(
        await screen.findByRole("menuitem", { name: "Open in Background" }),
      );

      expect(testState.openInBackground).toHaveBeenCalledWith(
        "epic-a",
        "Task a",
      );
      expect(testState.openItem).not.toHaveBeenCalled();
    });

    it("disables Open in Background for a task already open in a tab, keeping Open in New Window", async () => {
      testState.isNewWindowAvailable = true;
      useEpicCanvasStore.getState().openEpicTab("epic-a", "Task a");
      setGroups({ open: [task("a", {})] });
      renderSection();

      fireEvent.contextMenu(rowCard("a"));

      const background = await screen.findByTestId(
        "epics-list-row-open-background",
      );
      expect(background.hasAttribute("data-disabled")).toBe(true);
      expect(within(background).getByText("Already open")).not.toBeNull();
      fireEvent.click(background);
      expect(testState.openInBackground).not.toHaveBeenCalled();
      expect(
        screen.getByTestId("epics-list-row-open-new-window"),
      ).not.toBeNull();
    });

    it("asks to open the row's task in a new window", async () => {
      testState.isNewWindowAvailable = true;
      const item = task("a", {});
      setGroups({ open: [item] });
      renderSection();

      fireEvent.contextMenu(rowCard("a"));
      fireEvent.click(
        await screen.findByRole("menuitem", { name: "Open in New Window" }),
      );

      expect(testState.requestOpenInNewWindow).toHaveBeenCalledWith(item);
    });

    it("leaves out Open in New Window where there is no windows bridge", async () => {
      setGroups({ open: [task("a", {})] });
      renderSection();

      fireEvent.contextMenu(rowCard("a"));

      await screen.findByRole("menuitem", { name: "Open in Background" });
      expect(
        screen.queryByRole("menuitem", { name: "Open in New Window" }),
      ).toBeNull();
    });

    it("offers a phase only Open in New Window, since a phase cannot open in the background", async () => {
      testState.isNewWindowAvailable = true;
      setGroups({ open: [task("p", { taskType: "phase" })] });
      renderSectionWithOrganization(organizationView({}));

      fireEvent.contextMenu(rowCard("p"));

      expect(
        await screen.findByRole("menuitem", { name: "Open in New Window" }),
      ).not.toBeNull();
      expect(screen.queryByRole("menuitem", { name: "Labels" })).toBeNull();
      expect(
        screen.queryByRole("menuitem", { name: "Open in Background" }),
      ).toBeNull();
    });

    it("mounts no context menu for a phase when nothing is left to offer", () => {
      setGroups({ open: [task("p", { taskType: "phase" })] });
      renderSection();

      fireEvent.contextMenu(rowCard("p"));

      expect(screen.queryByRole("menu")).toBeNull();
    });
  });

  describe("middle click", () => {
    // A middle-button activation arrives as `auxclick`, never `click`.
    const auxClick = (name: string, button: number) =>
      fireEvent(
        screen.getByRole("button", { name }),
        new MouseEvent("auxclick", { bubbles: true, cancelable: true, button }),
      );
    const middleClick = (name: string) => auxClick(name, 1);

    it("opens the task in a background tab and leaves the page where it is", () => {
      setGroups({ open: [task("a", {})] });
      renderSection();

      middleClick("Open task Task a");

      expect(testState.openInBackground).toHaveBeenCalledWith(
        "epic-a",
        "Task a",
      );
      expect(testState.openItem).not.toHaveBeenCalled();
    });

    it("does not open a task that is already open in a tab again", () => {
      useEpicCanvasStore.getState().openEpicTab("epic-a", "Task a");
      setGroups({ open: [task("a", {})] });
      renderSection();

      middleClick("Open task Task a");

      expect(testState.openInBackground).not.toHaveBeenCalled();
      expect(testState.openItem).not.toHaveBeenCalled();
    });

    it("opens a phase in place, since a phase has no background open", () => {
      const phase = task("p", { taskType: "phase" });
      setGroups({ open: [phase] });
      renderSection();

      middleClick("Open task Task p");

      expect(testState.openItem).toHaveBeenCalledWith(phase);
      expect(testState.openInBackground).not.toHaveBeenCalled();
    });

    it("leaves the right button to the context menu", () => {
      setGroups({ open: [task("a", {})] });
      renderSection();

      auxClick("Open task Task a", 2);

      expect(testState.openInBackground).not.toHaveBeenCalled();
      expect(testState.openItem).not.toHaveBeenCalled();
    });
  });

  describe("a task whose deletion is in flight", () => {
    it("shows the delete in progress on its row only, and offers no pin there", () => {
      setGroups({ open: [task("a", {}), task("b", {})] });
      holdEpicBatchDelete(queryClient, ["epic-a"]);
      renderSection();

      const deleting = within(rowItem("a"));
      const live = within(rowItem("b"));

      const indicator = deleting.getByRole("status", {
        name: "Deleting Task a",
      });
      expect(indicator.getAttribute("data-testid")).toBe(
        "epics-list-row-deleting",
      );
      expect(tooltipTextNear(indicator)).toBe("This task is being deleted.");
      expect(
        deleting
          .getByTestId("epics-list-row-card")
          .getAttribute("data-deleting"),
      ).toBe("true");
      expect(live.queryByTestId("epics-list-row-deleting")).toBeNull();
      // The neighbour keeps its pin, so the deleting row's lack of one is the
      // row's own state rather than a page that offers none.
      expect(live.getByTestId("epics-list-row-pin")).not.toBeNull();
      expect(deleting.queryByTestId("epics-list-row-pin")).toBeNull();
    });

    it("marks its row target disabled", () => {
      setGroups({ open: [task("a", {}), task("b", {})] });
      holdEpicBatchDelete(queryClient, ["epic-a"]);
      renderSection();

      expect(
        screen
          .getByRole("button", { name: "Open task Task a" })
          .getAttribute("aria-disabled"),
      ).toBe("true");
      expect(
        screen
          .getByRole("button", { name: "Open task Task b" })
          .getAttribute("aria-disabled"),
      ).toBeNull();
    });

    it("states aria-disabled on its row target only, and clears it once the delete settles", async () => {
      setGroups({ open: [task("a", {}), task("b", {})] });
      const held = holdEpicBatchDelete(queryClient, ["epic-a"]);
      renderSection();

      // The neighbour is the control.
      expect(rowButton("a").getAttribute("aria-disabled")).toBe("true");
      expect(rowButton("b").hasAttribute("aria-disabled")).toBe(false);

      await act(async () => {
        await held.settle();
      });

      await waitFor(() => {
        expect(rowButton("a").hasAttribute("aria-disabled")).toBe(false);
      });
    });

    // This row's target is a native `<button>`, not a router `Link`: it has no
    // destination to take away, and a real `disabled` attribute would make it
    // unfocusable in a browser (jsdom cannot show that, so the attribute itself
    // is what is read). It stays in the keyboard's reach and refuses the open.
    it("does not natively disable its row target, which would take it out of the keyboard's reach", () => {
      setGroups({ open: [task("a", {}), task("b", {})] });
      holdEpicBatchDelete(queryClient, ["epic-a"]);
      renderSection();

      expect(rowButton("a").hasAttribute("disabled")).toBe(false);
      expect(rowButton("b").hasAttribute("disabled")).toBe(false);
    });

    it("opens its organization chip read-only, and a live row's editable, until the delete settles", async () => {
      setGroups({ open: [task("a", {}), task("b", {})] });
      const held = holdEpicBatchDelete(queryClient, ["epic-a"]);
      renderSectionWithOrganization(
        organizationView({
          taskLabels: {
            "epic-a": { labels: [taskLabel("Urgent")], removed: [] },
            "epic-b": { labels: [taskLabel("Urgent")], removed: [] },
          },
        }),
      );
      const chipOf = (id: string): HTMLElement =>
        within(rowItem(id)).getByRole("button", {
          name: /^Task organization/,
        });

      fireEvent.click(chipOf("b"));
      expect(openOrganizationDialog).toHaveBeenLastCalledWith({
        kind: "labels",
        taskId: "epic-b",
        canEdit: true,
      });

      fireEvent.click(chipOf("a"));
      expect(openOrganizationDialog).toHaveBeenLastCalledWith({
        kind: "labels",
        taskId: "epic-a",
        canEdit: false,
      });
      expect(openOrganizationDialog).toHaveBeenCalledTimes(2);

      await act(async () => {
        await held.settle();
      });

      await waitFor(() => {
        expect(screen.queryByTestId("epics-list-row-deleting")).toBeNull();
      });
      fireEvent.click(chipOf("a"));
      expect(openOrganizationDialog).toHaveBeenLastCalledWith({
        kind: "labels",
        taskId: "epic-a",
        canEdit: true,
      });
    });

    it("does not open in a background tab on a middle-click", () => {
      setGroups({ open: [task("a", {}), task("b", {})] });
      holdEpicBatchDelete(queryClient, ["epic-a"]);
      renderSection();

      fireEvent(
        screen.getByRole("button", { name: "Open task Task a" }),
        new MouseEvent("auxclick", {
          bubbles: true,
          cancelable: true,
          button: 1,
        }),
      );
      expect(testState.openInBackground).not.toHaveBeenCalled();

      // Control: the same gesture on the other row still opens it.
      fireEvent(
        screen.getByRole("button", { name: "Open task Task b" }),
        new MouseEvent("auxclick", {
          bubbles: true,
          cancelable: true,
          button: 1,
        }),
      );
      expect(testState.openInBackground).toHaveBeenCalledWith(
        "epic-b",
        "Task b",
      );
    });

    it("mounts no context menu", () => {
      testState.isNewWindowAvailable = true;
      setGroups({ open: [task("a", {})] });
      holdEpicBatchDelete(queryClient, ["epic-a"]);
      renderSection();

      fireEvent.contextMenu(
        within(rowItem("a")).getByTestId("epics-list-row-card"),
      );

      expect(screen.queryByRole("menu")).toBeNull();
      expect(
        screen.queryByRole("menuitem", { name: "Open in Background" }),
      ).toBeNull();
      expect(
        screen.queryByRole("menuitem", { name: "Open in New Window" }),
      ).toBeNull();
    });

    it("returns the row to normal once the delete settles", async () => {
      setGroups({ open: [task("a", {})] });
      const held = holdEpicBatchDelete(queryClient, ["epic-a"]);
      renderSection();
      expect(screen.getByTestId("epics-list-row-deleting")).not.toBeNull();

      await act(async () => {
        await held.settle();
      });

      await waitFor(() => {
        expect(screen.queryByTestId("epics-list-row-deleting")).toBeNull();
      });
      expect(screen.getByTestId("epics-list-row-pin")).not.toBeNull();
      expect(
        screen
          .getByRole("button", { name: "Open task Task a" })
          .getAttribute("aria-disabled"),
      ).toBeNull();
    });
  });

  describe("pull requests", () => {
    it("shows a task's PR pill on its row", () => {
      testState.worktreesByEpicId = new Map([
        ["epic-a", [taskWorktree("epic-a")]],
      ]);
      setGroups({ open: [task("a", {}), task("b", {})] });
      // The pill's links read the query client through the open-link seam.
      render(
        <QueryClientProvider client={new QueryClient()}>
          <CurrentTasksSection />
        </QueryClientProvider>,
      );

      const pills = within(rowItem("a")).getByTestId("task-history-prs-epic-a");
      expect(
        within(pills).getByRole("link", { name: "Open PR #84 Open" }),
      ).not.toBeNull();
      expect(
        within(rowItem("b")).queryByTestId("task-history-prs-epic-b"),
      ).toBeNull();
    });
  });

  describe("worktree reads", () => {
    const readEpicIds = () =>
      new Set(hostClients.worktreeReads.flatMap((read) => read.epicIds));
    const clientReadFor = (epicId: string) =>
      hostClients.worktreeReads.find((read) => read.epicIds.includes(epicId))
        ?.client;

    it("reads a task's worktrees from the host that owns it, and from the window's host when it names none", () => {
      setGroups({
        open: [
          task("a", { hostId: "host-b", isLocalHome: true }),
          task("c", {}),
        ],
      });
      renderSection();

      expect(hostClients.askedHostIds).toContain("host-b");
      expect(hostClients.askedHostIds).toContain(null);
      expect(clientReadFor("epic-a")).toBe(hostClients.clientFor("host-b"));
      expect(clientReadFor("epic-c")).toBe(hostClients.clientFor(null));
      expect(hostClients.clientFor("host-b")).not.toBe(
        hostClients.clientFor(null),
      );
    });

    it("reads only the task each row shows", () => {
      setGroups({ open: [task("a", {}), task("b", {})] });
      renderSection();

      expect(hostClients.worktreeReads.map((read) => read.epicIds)).toEqual(
        expect.arrayContaining([["epic-a"], ["epic-b"]]),
      );
      expect(
        hostClients.worktreeReads.every((read) => read.epicIds.length === 1),
      ).toBe(true);
    });

    it("reads nothing for rows hidden behind 'Show more' until they are shown", () => {
      setGroups({ open: tasks("o", 7) });
      renderSection();

      expect(rowIds()).toHaveLength(5);
      expect([...readEpicIds()].toSorted()).toEqual([
        "epic-o1",
        "epic-o2",
        "epic-o3",
        "epic-o4",
        "epic-o5",
      ]);

      fireEvent.click(screen.getByRole("button", { name: "Show 2 more" }));

      expect(rowIds()).toHaveLength(7);
      expect(readEpicIds().has("epic-o6")).toBe(true);
      expect(readEpicIds().has("epic-o7")).toBe(true);
    });
  });

  describe("History query independence", () => {
    it("does not change when a History query changes", () => {
      setGroups({
        inProgress: [task("a", {})],
        pinned: [task("b", { isPinned: true })],
        open: [task("c", {})],
      });
      const { container } = renderSection();
      const before = container.innerHTML;

      act(() => {
        useHistorySearchStore.setState({
          search: { ...DEFAULT_HISTORY_SEARCH, query: "no such task" },
        });
      });

      expect(container.innerHTML).toBe(before);
      expect(rowIds()).toEqual(["a", "b", "c"]);
    });
  });

  describe("empty and loading states", () => {
    interface Case {
      readonly isPending: boolean;
      readonly pinsComplete: boolean;
      readonly coverage: ActivityFleetCoverage;
    }
    const COVERAGES: readonly ActivityFleetCoverage[] = [
      "fleet",
      "partial",
      "none",
    ];
    const cases: Case[] = [];
    for (const isPending of [false, true]) {
      for (const pinsComplete of [true, false]) {
        for (const coverage of COVERAGES) {
          cases.push({ isPending, pinsComplete, coverage });
        }
      }
    }

    it.each(cases)(
      "claims 'No current tasks' only when settled, pins complete and fleet coverage: $isPending / $pinsComplete / $coverage",
      ({ isPending, pinsComplete, coverage }) => {
        testState.isPending = isPending;
        testState.pinsComplete = pinsComplete;
        testState.activityCoverage = coverage;
        renderSection();

        const claimsEmpty = screen.queryByText("No current tasks") !== null;

        expect(claimsEmpty).toBe(
          !isPending && pinsComplete && coverage === "fleet",
        );
        expect(
          screen.getByRole("heading", { name: "Current tasks" }),
        ).not.toBeNull();
        expect(screen.queryByText(CAPTION)).toBeNull();
      },
    );

    it("shows the empty state with a View history action when confirmed empty", () => {
      renderSection();

      expect(screen.getByText("No current tasks")).not.toBeNull();
      const emptyState = screen.getByText("No current tasks").parentElement;
      if (emptyState === null) throw new Error("expected empty state");
      fireEvent.click(
        within(emptyState).getByRole("button", { name: "View history" }),
      );
      expect(testState.openHistory).toHaveBeenCalledTimes(1);
    });

    it("shows the standard loader while a fleet-covered, empty list is pending", () => {
      testState.isPending = true;
      renderSection();

      expect(screen.getByTestId("epics-list-loading")).not.toBeNull();
      expect(screen.queryByText("No current tasks")).toBeNull();
      expect(screen.queryByText(COVERAGE_NOTICE)).toBeNull();
    });

    it("does not show the loader once there are rows, even while pending", () => {
      testState.isPending = true;
      setGroups({ open: [task("a", {})] });
      renderSection();

      expect(screen.queryByTestId("epics-list-loading")).toBeNull();
      expect(rowIds()).toEqual(["a"]);
    });

    it.each<ActivityFleetCoverage>(["partial", "none"])(
      "shows the muted coverage line in In progress for %s coverage, even while pending",
      (coverage) => {
        testState.activityCoverage = coverage;
        testState.isPending = true;
        renderSection();

        const inProgress = group("In progress");
        expect(within(inProgress).getByText(COVERAGE_NOTICE)).not.toBeNull();
        expect(screen.getByTestId("epics-list-loading")).not.toBeNull();
        expect(screen.queryByText("No current tasks")).toBeNull();
      },
    );

    it("keeps the coverage line above the rows in In progress", () => {
      testState.activityCoverage = "partial";
      setGroups({ inProgress: [task("a", {})] });
      renderSection();

      const inProgress = group("In progress");
      expect(within(inProgress).getByText(COVERAGE_NOTICE)).not.toBeNull();
      expect(
        within(inProgress).getByRole("button", { name: "Open task Task a" }),
      ).not.toBeNull();
    });

    it("explains the blank with zero rows, fleet coverage and incomplete pins, and never claims empty", () => {
      testState.pinsComplete = false;
      renderSection();

      expect(
        screen.getByRole("heading", { name: "Current tasks" }),
      ).not.toBeNull();
      expect(screen.queryByText(CAPTION)).toBeNull();
      expect(
        within(group("Pinned")).getByText(PINS_UNAVAILABLE_NOTICE),
      ).not.toBeNull();
      expect(screen.queryByText("No current tasks")).toBeNull();
      expect(screen.queryByText(COVERAGE_NOTICE)).toBeNull();
      expect(screen.queryByTestId("epics-list-loading")).toBeNull();
      expect(rowIds()).toEqual([]);
      // View history stays reachable from the header.
      fireEvent.click(screen.getByRole("button", { name: /^View history/ }));
      expect(testState.openHistory).toHaveBeenCalledTimes(1);
    });

    it.each<ActivityFleetCoverage>(["partial", "none"])(
      "shows the pins line beside the activity line for %s coverage when settled with incomplete pins",
      (coverage) => {
        testState.pinsComplete = false;
        testState.activityCoverage = coverage;
        renderSection();

        expect(
          within(group("Pinned")).getByText(PINS_UNAVAILABLE_NOTICE),
        ).not.toBeNull();
        expect(
          within(group("In progress")).getByText(COVERAGE_NOTICE),
        ).not.toBeNull();
        expect(screen.queryByText("No current tasks")).toBeNull();
        expect(screen.queryByTestId("epics-list-loading")).toBeNull();
      },
    );

    it("with pinned rows and incomplete pins, shows the partial line once, after the pinned rows", () => {
      testState.pinsComplete = false;
      setGroups({ pinned: [task("p1", {}), task("p2", {})] });
      renderSection();

      const notice = within(group("Pinned")).getByText(PINS_PARTIAL_NOTICE);
      expect(screen.getAllByText(PINS_PARTIAL_NOTICE)).toHaveLength(1);
      expect(screen.queryByText(PINS_UNAVAILABLE_NOTICE)).toBeNull();
      expect(rowIds()).toEqual(["p1", "p2"]);
      expect(
        rowButton("p2").compareDocumentPosition(notice) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it("shows the 'none' copy, not the partial one, when only other groups have rows and pins are incomplete", () => {
      testState.pinsComplete = false;
      setGroups({ open: [task("o1", {})] });
      renderSection();

      expect(
        within(group("Pinned")).getByText(PINS_UNAVAILABLE_NOTICE),
      ).not.toBeNull();
      expect(screen.queryByText(PINS_PARTIAL_NOTICE)).toBeNull();
      expect(rowIds()).toEqual(["o1"]);
    });

    it("does not show the pins line while pins are still loading or when they are complete", () => {
      testState.pinsComplete = false;
      testState.isPending = true;
      const view = renderSection();
      expect(screen.queryByText(PINS_UNAVAILABLE_NOTICE)).toBeNull();
      view.unmount();

      testState.pinsComplete = true;
      testState.isPending = false;
      testState.activityCoverage = "partial";
      renderSection();
      expect(screen.queryByText(PINS_UNAVAILABLE_NOTICE)).toBeNull();
    });
  });

  describe("group caps", () => {
    it("shows five rows per group and a 'Show N more' for each group independently", () => {
      setGroups({
        inProgress: tasks("i", 7),
        pinned: tasks("p", 6),
        open: tasks("o", 9),
      });
      renderSection();

      expect(
        within(group("In progress")).getAllByRole("listitem"),
      ).toHaveLength(5);
      expect(within(group("Pinned")).getAllByRole("listitem")).toHaveLength(5);
      expect(within(group("Open")).getAllByRole("listitem")).toHaveLength(5);
      expect(
        screen.getByRole("button", { name: "Show 2 more" }),
      ).not.toBeNull();
      expect(
        screen.getByRole("button", { name: "Show 1 more" }),
      ).not.toBeNull();
      expect(
        screen.getByRole("button", { name: "Show 4 more" }),
      ).not.toBeNull();
    });

    it("expands only the group whose 'Show N more' was pressed", () => {
      setGroups({
        inProgress: tasks("i", 7),
        pinned: tasks("p", 6),
        open: tasks("o", 9),
      });
      renderSection();

      fireEvent.click(screen.getByRole("button", { name: "Show 4 more" }));

      expect(within(group("Open")).getAllByRole("listitem")).toHaveLength(9);
      expect(
        within(group("In progress")).getAllByRole("listitem"),
      ).toHaveLength(5);
      expect(within(group("Pinned")).getAllByRole("listitem")).toHaveLength(5);
      expect(screen.queryByRole("button", { name: "Show 4 more" })).toBeNull();
      expect(
        screen.getByRole("button", { name: "Show 2 more" }),
      ).not.toBeNull();
      expect(
        screen.getByRole("button", { name: "Show 1 more" }),
      ).not.toBeNull();
    });

    it("offers no 'Show more' for a group of exactly five", () => {
      setGroups({ open: tasks("o", 5) });
      renderSection();

      expect(
        screen.queryByRole("button", { name: /Show \d+ more/ }),
      ).toBeNull();
      expect(within(group("Open")).getAllByRole("listitem")).toHaveLength(5);
    });
  });

  describe("keyboard", () => {
    beforeEach(() => {
      setGroups({
        inProgress: [task("a", {})],
        pinned: [task("b", { isPinned: true }), task("c", { isPinned: true })],
        open: [task("d", {})],
      });
    });

    it("never takes focus on mount", () => {
      renderSection();

      expect(document.activeElement).toBe(document.body);
    });

    it("ArrowDown moves through rows in visual order across groups", () => {
      renderSection();
      act(() => rowButton("a").focus());

      for (const expected of ["b", "c", "d"]) {
        fireEvent.keyDown(focused(), { key: "ArrowDown" });
        expect(document.activeElement).toBe(rowButton(expected));
      }
    });

    it("ArrowDown on the last row stays put", () => {
      renderSection();
      act(() => rowButton("d").focus());

      fireEvent.keyDown(rowButton("d"), { key: "ArrowDown" });

      expect(document.activeElement).toBe(rowButton("d"));
    });

    it("ArrowUp moves backwards across groups", () => {
      renderSection();
      act(() => rowButton("d").focus());

      for (const expected of ["c", "b", "a"]) {
        fireEvent.keyDown(focused(), { key: "ArrowUp" });
        expect(document.activeElement).toBe(rowButton(expected));
      }
    });

    it("ArrowUp on the first row stays put", () => {
      renderSection();
      act(() => rowButton("a").focus());

      fireEvent.keyDown(rowButton("a"), { key: "ArrowUp" });

      expect(document.activeElement).toBe(rowButton("a"));
    });

    it("ignores other keys", () => {
      renderSection();
      act(() => rowButton("a").focus());

      fireEvent.keyDown(rowButton("a"), { key: "ArrowRight" });
      fireEvent.keyDown(rowButton("a"), { key: "Tab" });

      expect(document.activeElement).toBe(rowButton("a"));
    });
  });

  describe("focus repair", () => {
    const viewHistory = () =>
      screen.getAllByRole("button", { name: /^View history/ })[0];

    beforeEach(() => {
      setGroups({
        inProgress: [task("a", {})],
        pinned: [task("b", { isPinned: true }), task("c", { isPinned: true })],
        open: [task("d", {})],
      });
    });

    it("moves focus to the next surviving row when the focused row is removed", () => {
      const view = renderSection();
      act(() => rowButton("b").focus());

      setGroups({
        inProgress: [task("a", {})],
        pinned: [task("c", { isPinned: true })],
        open: [task("d", {})],
      });
      view.rerender(<CurrentTasksSection />);

      expect(document.activeElement).toBe(rowButton("c"));
    });

    it("falls back to the previous surviving row when nothing follows", () => {
      const view = renderSection();
      act(() => rowButton("d").focus());

      setGroups({
        inProgress: [task("a", {})],
        pinned: [task("b", { isPinned: true }), task("c", { isPinned: true })],
      });
      view.rerender(<CurrentTasksSection />);

      expect(document.activeElement).toBe(rowButton("c"));
    });

    it("skips consecutive removed rows to the next survivor", () => {
      const view = renderSection();
      act(() => rowButton("b").focus());

      setGroups({
        inProgress: [task("a", {})],
        open: [task("d", {})],
      });
      view.rerender(<CurrentTasksSection />);

      expect(document.activeElement).toBe(rowButton("d"));
    });

    it("lands on View history when the last row disappears", () => {
      setGroups({ open: [task("d", {})] });
      const view = renderSection();
      act(() => rowButton("d").focus());

      setGroups({});
      testState.pinsComplete = false;
      view.rerender(<CurrentTasksSection />);

      expect(document.activeElement).toBe(viewHistory());
    });

    it("follows a focused pin that is unpinned out of the section", () => {
      const view = renderSection();
      act(() => rowButton("c").focus());

      // Unpinning removes the row from Pinned; it is not open either.
      setGroups({
        inProgress: [task("a", {})],
        pinned: [task("b", { isPinned: true })],
        open: [task("d", {})],
      });
      view.rerender(<CurrentTasksSection />);

      expect(document.activeElement).toBe(rowButton("d"));
    });

    it("keeps focus on a row that moves to another group", () => {
      const view = renderSection();
      act(() => rowButton("c").focus());

      // `c` starts working: it leaves Pinned for In progress.
      setGroups({
        inProgress: [task("a", {}), task("c", { isPinned: true })],
        pinned: [task("b", { isPinned: true })],
        open: [task("d", {})],
      });
      view.rerender(<CurrentTasksSection />);

      expect(document.activeElement).toBe(rowButton("c"));
      expect(
        within(group("In progress")).getByRole("button", {
          name: "Open task Task c",
        }),
      ).not.toBeNull();
    });

    it("does not steal focus that is elsewhere when a row disappears", () => {
      const view = renderSection();
      const outside = document.createElement("button");
      document.body.append(outside);
      act(() => outside.focus());

      setGroups({ inProgress: [task("a", {})] });
      view.rerender(<CurrentTasksSection />);

      expect(document.activeElement).toBe(outside);
      outside.remove();
    });
  });
});

function focused(): HTMLElement {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) throw new Error("nothing is focused");
  return active;
}

function rowItem(id: string): HTMLElement {
  const item = rowButton(id).closest("li");
  if (item === null) throw new Error(`no list item for ${id}`);
  return item;
}
