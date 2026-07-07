import "../../../../__tests__/test-browser-apis";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EpicsListPanel,
  type EpicsListPanelVariant,
} from "@/components/epics/epics-list-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import type { HistoryFacets } from "@/hooks/home/use-history-query";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useHistorySearchStore } from "@/stores/home/history-search-store";
import { DEFAULT_HISTORY_SEARCH } from "@/lib/history-search";
import { WindowsBridgeContext } from "@/providers/windows-bridge-context";
import { setDesktopEpicOwnershipBridge } from "@/lib/windows/desktop-epic-ownership";
import type { DesktopWindowsBridge } from "@/lib/windows/types";

/**
 * Light up the desktop "Open in New Window" path: both the renderer context
 * bridge (gates the menu item via `useWindowsBridge`) and the module-level
 * ownership bridge (gates `useEpicOpenInNewWindowFlow.isAvailable`) must be set.
 */
function enableDesktopBridge(): void {
  const bridge = stubWindowsBridge();
  testState.bridge = bridge;
  setDesktopEpicOwnershipBridge(bridge);
}

function stubWindowsBridge(): DesktopWindowsBridge {
  const disposable = { dispose: vi.fn() };
  return {
    windowId: "window-test",
    list: vi.fn(() => Promise.resolve([])),
    onChange: vi.fn(() => disposable),
    requestNew: vi.fn(() => Promise.resolve()),
    requestFocus: vi.fn(() => Promise.resolve()),
    requestClose: vi.fn(() => Promise.resolve()),
    requestOpenEpicInNewWindow: vi.fn(() =>
      Promise.resolve({ result: "focused", windowId: "window-test" } as const),
    ),
    ownership: {
      snapshot: vi.fn(() => Promise.resolve([])),
      claim: vi.fn(() => Promise.resolve({ ok: true } as const)),
      release: vi.fn(() => Promise.resolve()),
      onChange: vi.fn(() => disposable),
    },
    perWindowState: {
      get: vi.fn(() =>
        Promise.resolve({
          epicTabs: [],
          activeTabId: null,
          canvasByTabId: {},
          landingDrafts: [],
          activeLandingDraftId: null,
        }),
      ),
      update: vi.fn(() => Promise.resolve()),
      onChange: vi.fn(() => disposable),
    },
    authSession: {
      get: vi.fn(() =>
        Promise.resolve({
          status: "signed-out",
          token: null,
          profile: null,
        } as const),
      ),
      set: vi.fn(() => Promise.resolve()),
      onChange: vi.fn(() => disposable),
    },
  };
}

interface RenameEpicTitleVariables {
  readonly epicDelta: {
    readonly id: string;
    readonly title: string;
    readonly updatedAt: number;
  };
}

interface WorktreeCleanupCandidateStub {
  readonly worktreePath: string;
  readonly repoLabel: string;
  readonly branch: string | null;
  readonly uncommittedCount: number;
  readonly branchStatus: {
    readonly ahead: number | null;
    readonly behind: number | null;
    readonly mergedIntoDefault: boolean;
  } | null;
  readonly ownerEpicIds: ReadonlyArray<string>;
  // The shared-classifier verdict the hook computes (post-delete owners emptied);
  // it drives the default-checked state. Injected directly in these dialog tests.
  readonly provenRemovable: boolean;
}

interface DeleteEpicsVariables {
  readonly ids: string[];
  readonly worktreeCleanup: {
    readonly candidates: ReadonlyArray<{
      readonly worktreePath: string;
      readonly ownerEpicIds: ReadonlyArray<string>;
    }>;
  } | null;
}

interface DeleteEpicsMutationOptions {
  readonly onSuccess: () => void;
}

const testState = vi.hoisted(() => ({
  items: [] as HistoryItem[],
  availableRepos: [] as string[],
  availableWorkspaces: [] as HistoryItem["linkedWorkspaces"],
  activityByEpicId: new Map<string, "idle" | "running" | "waiting">(),
  facets: {
    repos: [] as HistoryFacets["repos"],
    workspaces: [] as HistoryFacets["workspaces"],
    ownershipScopes: [] as HistoryFacets["ownershipScopes"],
  },
  isFetching: false,
  bridge: null as DesktopWindowsBridge | null,
  worktreeCandidates: [] as WorktreeCleanupCandidateStub[],
  mutate:
    vi.fn<
      (
        variables: DeleteEpicsVariables,
        options: DeleteEpicsMutationOptions,
      ) => void
    >(),
  renameMutate: vi.fn<(variables: RenameEpicTitleVariables) => void>(),
  refetch: vi.fn(),
  fetchNextPage: vi.fn(),
}));

vi.mock("@/hooks/home/use-history-query", () => ({
  useHistoryQuery: () => ({
    data: {
      items: testState.items,
      availableRepos: testState.availableRepos,
      availableWorkspaces: testState.availableWorkspaces,
      totalCount: testState.items.length,
      facets: testState.facets,
    },
    isPending: false,
    isFetching: testState.isFetching,
    error: null,
    hostId: "host-test",
    refetch: testState.refetch,
    fetchNextPage: testState.fetchNextPage,
    hasNextPage: false,
    isFetchingNextPage: false,
  }),
}));

vi.mock("@/hooks/epic/use-epic-batch-delete-mutation", () => ({
  useEpicBatchDelete: () => ({
    isPending: false,
    mutate: testState.mutate,
  }),
}));

vi.mock("@/hooks/epic/use-task-delete-worktree-candidates-query", () => ({
  useTaskDeleteWorktreeCandidates: () => ({
    candidates: testState.worktreeCandidates,
    isError: false,
  }),
}));

vi.mock("@/hooks/epic/use-epic-title-mutation", () => ({
  useEpicUpdateTitle: () => ({
    isPending: false,
    mutate: testState.renameMutate,
  }),
}));

vi.mock("@/hooks/epic/use-epic-activity-status", () => ({
  useEpicActivityStatus: (epicId: string | null) =>
    epicId === null
      ? "idle"
      : (testState.activityByEpicId.get(epicId) ?? "idle"),
}));

function historyItem(overrides: Partial<HistoryItem>): HistoryItem {
  return {
    id: "history-epic-1",
    epicId: "epic-from-history",
    taskType: "epic",
    title: "Open from landing",
    initialUserPrompt: "",
    updatedAtMs: 1_700_000_000_000,
    updatedLabel: "about 2 hours ago",
    updatedBucket: "today",
    linkedRepos: [],
    linkedWorkspaces: [],
    ownership: "mine",
    permissionRole: "owner",
    ...overrides,
  };
}

function renderPanel(variant: EpicsListPanelVariant, initialEntry: string) {
  const rootRoute = createRootRoute({
    component: () => <RootOutlet />,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <EpicsListPanel
        variant={variant}
        onSelectEpic={null}
        routeSearch={null}
        historyNowMs={null}
        autoFocusSearch={false}
      />
    ),
  });
  const oldEpicRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/epics/$epicId",
    component: () => <div data-testid="old-epic-route" />,
  });
  const tabEpicRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/epics/$epicId/$tabId",
    component: () => <div data-testid="epic-tab-route" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, oldEpicRoute, tabEpicRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

function RootOutlet(): ReactNode {
  const content = (
    <TooltipProvider>
      <Outlet />
    </TooltipProvider>
  );
  if (testState.bridge === null) return content;
  return (
    <WindowsBridgeContext.Provider
      value={{ bridge: testState.bridge, hasHydrated: true }}
    >
      {content}
    </WindowsBridgeContext.Provider>
  );
}

describe("<EpicsListPanel />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    testState.items = [historyItem({})];
    testState.availableRepos = [];
    testState.availableWorkspaces = [];
    testState.facets = {
      repos: [],
      workspaces: [],
      ownershipScopes: [],
    };
    testState.isFetching = false;
    testState.bridge = null;
    testState.worktreeCandidates = [];
    setDesktopEpicOwnershipBridge(null);
    testState.mutate.mockReset();
    testState.renameMutate.mockReset();
    testState.refetch.mockReset();
    testState.fetchNextPage.mockReset();
    testState.activityByEpicId.clear();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useHistorySearchStore.setState({ search: DEFAULT_HISTORY_SEARCH });
  });

  afterEach(() => {
    cleanup();
    setDesktopEpicOwnershipBridge(null);
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useHistorySearchStore.setState({ search: DEFAULT_HISTORY_SEARCH });
  });

  it("opens landing history rows through the canonical epic tab route", async () => {
    const router = renderPanel("embedded", "/");

    fireEvent.click(
      await screen.findByRole("link", { name: /open task open from landing/i }),
    );

    await waitFor(() => {
      const tabId = useEpicCanvasStore
        .getState()
        .resolveTabIdForEpic("epic-from-history");
      expect(tabId).not.toBeNull();
      expect(router.state.location.pathname).toBe(
        `/epics/epic-from-history/${tabId}`,
      );
    });
    expect(screen.queryByTestId("old-epic-route")).toBeNull();
  });

  it("offers both context-menu actions for an epic row", async () => {
    enableDesktopBridge();
    renderPanel("embedded", "/");

    fireEvent.contextMenu(await screen.findByTestId("epics-list-row-card"));

    expect(
      await screen.findByTestId("epics-list-row-open-background"),
    ).toBeDefined();
    expect(
      screen.queryByTestId("epics-list-row-open-new-window"),
    ).not.toBeNull();
  });

  it("hides Open in Background for phase rows, keeping Open in New Window", async () => {
    // A phase only opens through its migration route (migrationSource=phase),
    // which a plain background canvas tab can't carry - so background-open is
    // suppressed while the route-based New Window action stays available.
    enableDesktopBridge();
    testState.items = [
      historyItem({
        id: "history-phase-1",
        epicId: "phase-1",
        taskType: "phase",
        title: "Phase from history",
      }),
    ];
    renderPanel("embedded", "/");

    fireEvent.contextMenu(await screen.findByTestId("epics-list-row-card"));

    expect(
      await screen.findByTestId("epics-list-row-open-new-window"),
    ).toBeDefined();
    expect(screen.queryByTestId("epics-list-row-open-background")).toBeNull();
  });

  it("mounts no context menu for a phase row in browser mode (no windows bridge)", async () => {
    // Browser build: no windows bridge, so Open in New Window is unavailable and
    // the phase row already suppresses Open in Background. With no action left,
    // the row must not wrap itself in a context menu - right-click must never
    // pop an empty menu.
    testState.items = [
      historyItem({
        id: "history-phase-web",
        epicId: "phase-web",
        taskType: "phase",
        title: "Phase in browser",
      }),
    ];
    renderPanel("embedded", "/");

    fireEvent.contextMenu(await screen.findByTestId("epics-list-row-card"));

    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByTestId("epics-list-row-open-background")).toBeNull();
    expect(screen.queryByTestId("epics-list-row-open-new-window")).toBeNull();
  });

  it("shows the running activity status on history rows", async () => {
    testState.activityByEpicId.set("epic-from-history", "running");
    renderPanel("embedded", "/");

    expect(
      await screen.findByTestId("epics-list-row-activity-epic-from-history"),
    ).toBeDefined();
    expect(screen.queryByTitle("Task activity in progress")).not.toBeNull();
  });

  it("shows the waiting activity status on history rows", async () => {
    testState.activityByEpicId.set("epic-from-history", "waiting");
    renderPanel("embedded", "/");

    expect(
      await screen.findByTestId("epics-list-row-waiting-epic-from-history"),
    ).toBeDefined();
    expect(
      screen.queryByTitle("Task waiting for your approval"),
    ).not.toBeNull();
  });

  it("selects a history row from the outside checkbox without opening the epic", async () => {
    const router = renderPanel("embedded", "/");

    const checkbox = await screen.findByRole("checkbox", {
      name: /select open from landing/i,
    });
    expect(checkbox.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(checkbox);

    expect(router.state.location.pathname).toBe("/");
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    expect(
      screen.getByTestId("epics-list-delete-selected").matches(":disabled"),
    ).toBe(false);
  });

  it("selects a history row with ctrl-click without opening the epic", async () => {
    const router = renderPanel("embedded", "/");

    fireEvent.click(
      await screen.findByRole("link", {
        name: /open task open from landing/i,
      }),
      { ctrlKey: true },
    );

    expect(router.state.location.pathname).toBe("/");
    expect(
      screen
        .getByRole("checkbox", { name: /select open from landing/i })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByTestId("epics-list-delete-selected").matches(":disabled"),
    ).toBe(false);
  });

  it("hides history title edit controls in selection mode", async () => {
    renderPanel("embedded", "/");

    expect(
      await screen.findByRole("button", {
        name: /edit title for open from landing/i,
      }),
    ).not.toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Select history items" }),
    );

    expect(
      screen.queryByRole("button", {
        name: /edit title for open from landing/i,
      }),
    ).toBeNull();
  });

  it("selects all visible history rows and cancels selection mode", async () => {
    testState.items = [
      historyItem({}),
      historyItem({
        id: "history-epic-2",
        epicId: "epic-two",
        title: "Second history item",
      }),
    ];
    renderPanel("embedded", "/");

    fireEvent.click(
      await screen.findByRole("button", { name: "Select history items" }),
    );
    expect(
      screen.getByTestId("epics-list-delete-selected").matches(":disabled"),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Select all" }));

    expect(
      screen
        .getAllByRole("checkbox")
        .every((checkbox) => checkbox.getAttribute("aria-checked") === "true"),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(
      screen
        .getAllByTestId("epics-list-row-select")
        .every((checkbox) => checkbox.getAttribute("aria-checked") === "false"),
    ).toBe(true);
    expect(screen.queryByTestId("epics-list-delete-selected")).toBeNull();
  });

  it("toggles Select all to Deselect all once every row is selected", async () => {
    testState.items = [
      historyItem({}),
      historyItem({
        id: "history-epic-2",
        epicId: "epic-two",
        title: "Second history item",
      }),
    ];
    renderPanel("embedded", "/");

    fireEvent.click(
      await screen.findByRole("button", { name: "Select history items" }),
    );

    expect(screen.queryByRole("button", { name: "Deselect all" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));

    expect(
      screen
        .getAllByRole("checkbox")
        .every((checkbox) => checkbox.getAttribute("aria-checked") === "true"),
    ).toBe(true);
    // All selected: the button flips to "Deselect all".
    expect(screen.queryByRole("button", { name: "Select all" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Deselect all" }));

    // Back to nothing selected, still in selection mode (delete control stays),
    // and the button reverts to "Select all".
    expect(
      screen
        .getAllByTestId("epics-list-row-select")
        .every((checkbox) => checkbox.getAttribute("aria-checked") === "false"),
    ).toBe(true);
    expect(screen.queryByTestId("epics-list-delete-selected")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Select all" })).not.toBeNull();
  });

  it("skips viewer rows during history select all and disables them in selection mode", async () => {
    testState.items = [
      historyItem({}),
      historyItem({
        id: "viewer-history-epic",
        epicId: "viewer-epic",
        title: "Viewer history item",
        ownership: "shared",
        permissionRole: "viewer",
      }),
    ];
    renderPanel("embedded", "/");

    const viewerCheckbox = await screen.findByRole("checkbox", {
      name: /select viewer history item/i,
    });
    expect(viewerCheckbox.className).toContain("opacity-0");
    expect(viewerCheckbox.className).toContain(
      "group-hover/list-row:opacity-50",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Select history items" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));

    const checkboxes = screen.getAllByTestId("epics-list-row-select");
    expect(checkboxes[0].getAttribute("aria-checked")).toBe("true");
    expect(checkboxes[1].getAttribute("aria-checked")).toBe("false");
    expect(checkboxes[1].getAttribute("aria-disabled")).toBe("true");
    expect(
      screen
        .getAllByTestId("epics-list-row-card")[1]
        .getAttribute("data-selection-disabled"),
    ).toBe("true");

    fireEvent.click(screen.getByTestId("epics-list-delete-selected"));
    fireEvent.click(screen.getByTestId("delete-tasks-confirm"));

    expect(testState.mutate).toHaveBeenCalledTimes(1);
    const deleteCall = testState.mutate.mock.calls.at(0);
    if (deleteCall === undefined) {
      throw new Error("expected selected epic delete mutation call");
    }
    const [variables] = deleteCall;
    expect(variables).toEqual({
      ids: ["epic-from-history"],
      worktreeCleanup: null,
    });
  });

  it("disables history selection when every visible row is viewer-only", async () => {
    testState.items = [
      historyItem({
        ownership: "shared",
        permissionRole: "viewer",
      }),
    ];
    renderPanel("embedded", "/");

    const selectButton = await screen.findByRole("button", {
      name: "Select history items",
    });
    expect(selectButton.matches(":disabled")).toBe(true);
    expect(screen.getByTestId("epics-list-row-select").className).toContain(
      "opacity-0",
    );
  });

  it("deletes selected history rows from selection mode", async () => {
    testState.items = [
      historyItem({}),
      historyItem({
        id: "history-epic-2",
        epicId: "epic-two",
        title: "Second history item",
      }),
    ];
    renderPanel("embedded", "/");

    fireEvent.click(
      await screen.findByRole("button", { name: "Select history items" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    fireEvent.click(screen.getByTestId("epics-list-delete-selected"));
    fireEvent.click(screen.getByTestId("delete-tasks-confirm"));

    expect(testState.mutate).toHaveBeenCalledTimes(1);
    const deleteCall = testState.mutate.mock.calls.at(0);
    if (deleteCall === undefined) {
      throw new Error("expected selected epic delete mutation call");
    }
    const [variables, options] = deleteCall;
    expect(variables).toEqual({
      ids: ["epic-from-history", "epic-two"],
      worktreeCleanup: null,
    });
    expect(typeof options.onSuccess).toBe("function");
  });

  it("checks only PROVEN-removable rows by default (unproven and dirty stay unchecked)", async () => {
    testState.worktreeCandidates = [
      {
        // Proven: clean + non-null status (merged) -> checked.
        worktreePath: "/wt/proven",
        repoLabel: "owner/repo",
        branch: "feat/proven",
        uncommittedCount: 0,
        branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: true },
        ownerEpicIds: ["epic-from-history"],
        provenRemovable: true,
      },
      {
        // Clean but branch status unavailable (null) -> UNPROVEN -> unchecked.
        worktreePath: "/wt/unproven",
        repoLabel: "owner/repo",
        branch: "feat/unproven",
        uncommittedCount: 0,
        branchStatus: null,
        ownerEpicIds: ["epic-from-history"],
        provenRemovable: false,
      },
      {
        worktreePath: "/wt/dirty",
        repoLabel: "owner/repo",
        branch: "feat/dirty",
        uncommittedCount: 3,
        branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: true },
        ownerEpicIds: ["epic-from-history"],
        provenRemovable: false,
      },
    ];
    renderPanel("embedded", "/");

    fireEvent.click(await screen.findByTestId("epics-list-row-delete"));
    expect(
      await screen.findByTestId("delete-tasks-worktree-cleanup"),
    ).not.toBeNull();

    const checkboxes = screen.getAllByTestId("delete-tasks-worktree-checkbox");
    expect(checkboxes[0].getAttribute("aria-checked")).toBe("true");
    expect(checkboxes[1].getAttribute("aria-checked")).toBe("false");
    expect(checkboxes[2].getAttribute("aria-checked")).toBe("false");

    // Only the proven (checked) worktree is approved for removal by default.
    fireEvent.click(screen.getByTestId("delete-tasks-confirm"));
    const deleteCall = testState.mutate.mock.calls.at(0);
    if (deleteCall === undefined) {
      throw new Error("expected epic delete mutation call");
    }
    expect(deleteCall[0]).toEqual({
      ids: ["epic-from-history"],
      worktreeCleanup: {
        candidates: [
          { worktreePath: "/wt/proven", ownerEpicIds: ["epic-from-history"] },
        ],
      },
    });
  });

  it("names local-only commits and leaves a clean-ahead candidate unchecked by default", async () => {
    testState.worktreeCandidates = [
      {
        worktreePath: "/wt/ahead",
        repoLabel: "owner/repo",
        branch: "feat/ahead",
        uncommittedCount: 0,
        branchStatus: { ahead: 3, behind: 0, mergedIntoDefault: false },
        ownerEpicIds: ["epic-from-history"],
        provenRemovable: false,
      },
    ];
    renderPanel("embedded", "/");

    fireEvent.click(await screen.findByTestId("epics-list-row-delete"));
    const checkbox = await screen.findByTestId(
      "delete-tasks-worktree-checkbox",
    );
    // Unmerged local-only commits are not proven-removable -> default unchecked,
    // and the concrete loss is named.
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    screen.getByText(/3 commits not on the default branch/i);
  });

  it("names never-pushed local-only commits and leaves the row unchecked by default", async () => {
    testState.worktreeCandidates = [
      {
        worktreePath: "/wt/never-pushed",
        repoLabel: "owner/repo",
        branch: "feat/never-pushed",
        uncommittedCount: 0,
        // No upstream (ahead null) and not contained in the default branch:
        // must stay unchecked and carry the honest local-only hint, not the
        // generic "unverified" note.
        branchStatus: { ahead: null, behind: null, mergedIntoDefault: false },
        ownerEpicIds: ["epic-from-history"],
        provenRemovable: false,
      },
    ];
    renderPanel("embedded", "/");

    fireEvent.click(await screen.findByTestId("epics-list-row-delete"));
    const checkbox = await screen.findByTestId(
      "delete-tasks-worktree-checkbox",
    );
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    screen.getByText(/local-only commits not on the default branch/i);
  });

  it("includes a dirty worktree once its warning row is checked", async () => {
    testState.worktreeCandidates = [
      {
        worktreePath: "/wt/dirty",
        repoLabel: "owner/repo",
        branch: "feat/dirty",
        uncommittedCount: 2,
        branchStatus: null,
        ownerEpicIds: ["epic-from-history"],
        provenRemovable: false,
      },
    ];
    renderPanel("embedded", "/");

    fireEvent.click(await screen.findByTestId("epics-list-row-delete"));
    const checkbox = await screen.findByTestId(
      "delete-tasks-worktree-checkbox",
    );
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(checkbox);

    fireEvent.click(screen.getByTestId("delete-tasks-confirm"));
    const deleteCall = testState.mutate.mock.calls.at(0);
    if (deleteCall === undefined) {
      throw new Error("expected epic delete mutation call");
    }
    expect(deleteCall[0].worktreeCleanup).toEqual({
      candidates: [
        { worktreePath: "/wt/dirty", ownerEpicIds: ["epic-from-history"] },
      ],
    });
  });

  it("surfaces a detached-HEAD warning even when branchStatus is populated", async () => {
    testState.worktreeCandidates = [
      {
        worktreePath: "/wt/detached",
        repoLabel: "owner/repo",
        // Detached HEAD (no branch ref) can still carry a probed branchStatus
        // (e.g. against the workspace's default branch) - the detached hint
        // must win regardless, since removal can orphan the commit.
        branch: null,
        uncommittedCount: 0,
        branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: true },
        ownerEpicIds: ["epic-from-history"],
        provenRemovable: false,
      },
    ];
    renderPanel("embedded", "/");

    fireEvent.click(await screen.findByTestId("epics-list-row-delete"));
    const checkbox = await screen.findByTestId(
      "delete-tasks-worktree-checkbox",
    );
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    screen.getByText(/detached head — commits could be orphaned/i);
  });

  it("omits the worktree cleanup section when there are no candidates", async () => {
    renderPanel("embedded", "/");
    fireEvent.click(await screen.findByTestId("epics-list-row-delete"));
    expect(await screen.findByTestId("delete-tasks-dialog")).not.toBeNull();
    expect(screen.queryByTestId("delete-tasks-worktree-cleanup")).toBeNull();
  });

  it("edits an epic title from a history row without opening the epic", async () => {
    const router = renderPanel("embedded", "/");

    fireEvent.click(
      await screen.findByRole("button", {
        name: /edit title for open from landing/i,
      }),
    );

    const input = await screen.findByRole("textbox", {
      name: /rename open from landing/i,
    });
    expect(router.state.location.pathname).toBe("/");
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: "Edited from history" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(testState.renameMutate).toHaveBeenCalledTimes(1);
    const variables = testState.renameMutate.mock.calls[0][0];
    expect(variables.epicDelta.id).toBe("epic-from-history");
    expect(variables.epicDelta.title).toBe("Edited from history");
    expect(typeof variables.epicDelta.updatedAt).toBe("number");
    expect(router.state.location.pathname).toBe("/");
  });

  it("shows disabled history title editing for viewer rows", async () => {
    testState.items = [
      historyItem({ ownership: "shared", permissionRole: "viewer" }),
    ];

    renderPanel("embedded", "/");

    expect(await screen.findByText("Open from landing")).not.toBeNull();
    expect(screen.queryByTestId("epics-list-row-edit-title")).toBeNull();
    const disabledEdit = screen.getByRole("button", {
      name: /viewers can't edit title for open from landing/i,
    });
    expect(disabledEdit.getAttribute("aria-disabled")).toBe("true");
  });

  it("opens the filter popover and live-applies selections to typed route search", async () => {
    testState.availableRepos = ["traycer/gui-app"];
    testState.availableWorkspaces = [
      { hostId: "host-test", workspacePath: "/Users/me/gui-app" },
    ];
    testState.facets = {
      repos: [{ label: "traycer/gui-app", count: 2 }],
      workspaces: [
        {
          workspace: {
            hostId: "host-test",
            workspacePath: "/Users/me/gui-app",
          },
          count: 2,
        },
      ],
      ownershipScopes: [
        { value: "mine", count: 3 },
        { value: "shared", count: 1 },
      ],
    };
    renderPanel("embedded", "/");

    fireEvent.click(await screen.findByRole("button", { name: /filter/i }));
    expect(await screen.findByTestId("epics-filter-popover")).not.toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: /shared/i }));
    await waitFor(() => {
      expect(useHistorySearchStore.getState().search).toMatchObject({
        ownershipScopes: ["shared"],
      });
    });

    fireEvent.click(
      screen.getByRole("checkbox", { name: /traycer\/gui-app/i }),
    );
    await waitFor(() => {
      expect(useHistorySearchStore.getState().search).toMatchObject({
        ownershipScopes: ["shared"],
        repos: ["traycer/gui-app"],
      });
    });

    fireEvent.click(
      screen.getByRole("checkbox", { name: /\/Users\/me\/gui-app/i }),
    );
    await waitFor(() => {
      expect(useHistorySearchStore.getState().search).toMatchObject({
        ownershipScopes: ["shared"],
        repos: ["traycer/gui-app"],
        workspaces: [
          { hostId: "host-test", workspacePath: "/Users/me/gui-app" },
        ],
      });
    });
  });

  it("disambiguates same-path workspace filters by host identity", async () => {
    const workspacePath = "/Users/me/traycer";
    testState.availableWorkspaces = [
      { hostId: "host-a", workspacePath },
      { hostId: "host-b", workspacePath },
    ];
    testState.facets = {
      repos: [],
      workspaces: [
        {
          workspace: { hostId: "host-a", workspacePath },
          count: 3,
        },
        {
          workspace: { hostId: "host-b", workspacePath },
          count: 22,
        },
      ],
      ownershipScopes: [],
    };
    renderPanel("embedded", "/");

    fireEvent.click(await screen.findByRole("button", { name: /filter/i }));

    const workspaceOptions = screen
      .getAllByRole("checkbox")
      .filter((option) => option.textContent.includes(workspacePath));
    expect(workspaceOptions).toHaveLength(2);
    expect(workspaceOptions.map((option) => option.textContent)).toEqual([
      expect.stringContaining("host-a"),
      expect.stringContaining("host-b"),
    ]);

    fireEvent.click(screen.getByRole("checkbox", { name: /host-b/i }));
    await waitFor(() => {
      expect(useHistorySearchStore.getState().search).toMatchObject({
        workspaces: [{ hostId: "host-b", workspacePath }],
      });
    });
  });

  it("preserves spaces typed into the page search box", async () => {
    renderPanel("page", "/");
    const input = await screen.findByRole("searchbox", {
      name: "Search tasks",
    });

    fireEvent.change(input, { target: { value: "hello " } });

    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe("hello ");
      expect(useHistorySearchStore.getState().search).toMatchObject({
        query: "hello ",
      });
    });
  });

  it("keeps the filtered empty state pending while a filter request is still fetching", async () => {
    testState.items = [];
    testState.isFetching = true;
    useHistorySearchStore.setState({
      search: { ...DEFAULT_HISTORY_SEARCH, query: "missing" },
    });

    renderPanel("page", "/");

    expect(
      await screen.findByTestId("epics-list-filter-loading"),
    ).not.toBeNull();
    expect(screen.queryByTestId("epics-list-filtered-empty")).toBeNull();
  });

  it("shows the filtered empty state after the filter request settles", async () => {
    testState.items = [];
    useHistorySearchStore.setState({
      search: { ...DEFAULT_HISTORY_SEARCH, query: "missing" },
    });

    renderPanel("page", "/");

    expect(
      await screen.findByTestId("epics-list-filtered-empty"),
    ).not.toBeNull();
    expect(screen.queryByTestId("epics-list-filter-loading")).toBeNull();
  });
});
