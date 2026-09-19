/**
 * History's scope control end to end: the real `<EpicsListPanel>` (page and
 * picker) with only the host boundaries faked. What lives here is what the
 * panel suite and the message-hits suite cannot see alone - which lists are
 * mounted per scope, the keyboard path through the tab bar, the disabled task
 * controls in Messages, the truthful badges, and selection mode.
 */
import "./stub-sweep-dialog-host-hooks";

import type { ListTasksCompleteness } from "@traycer/protocol/host/epic/unary-schemas";
import type { ChatSearchMessageMatch } from "@traycer/protocol/host/chat-search/schemas";
import type { ChatSearchMessageHitsStatus } from "@/hooks/chats/use-chat-search-message-hits";

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

import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSyncExternalStore, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PickerEpicsListPanel } from "@/components/epics/epics-list-panel";
import { ScopedEpicsListPanel } from "./scoped-panel-harness";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useHistorySearchStore } from "@/stores/home/history-search-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  DEFAULT_HISTORY_SEARCH,
  type HistorySearchState,
} from "@/lib/history-search";
import type { HistoryScope } from "@/lib/history-scope";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

const testState = vi.hoisted(() => ({
  items: [] as HistoryItem[],
  hostId: "host-test" as string | null,
  isPending: false,
  cloudPagePending: false,
  hasNextPage: false,
  error: null as Error | null,
  completeness: null as ListTasksCompleteness | null,
  chatHostFilterUnsupported: false,
  hostRequiresCloudToList: false,
  refetch: vi.fn<() => Promise<void>>(),
  // Render counters: a message count landing must not re-render the panel body
  // (which owns the history query) nor the task rows (which read activity).
  historyQueryCalls: 0,
  activityCalls: 0,
  hitsCalls: 0,
  chatSearchClient: null as { readonly getActiveHostId: () => string } | null,
}));

// The message controller's answer lives outside React so a test can move it
// WITHOUT re-rendering the panel: only the subscribed section re-renders,
// which is exactly the arrival path the count wrapper has to absorb.
const hitsStore = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const box: { status: ChatSearchMessageHitsStatus } = {
    status: { kind: "absent" },
  };
  return {
    box,
    listeners,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    read: (): ChatSearchMessageHitsStatus => box.status,
  };
});

const stubChatSearchHostClient = { getActiveHostId: () => "host-test" };

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useOptionalHostClient: () => testState.chatSearchClient,
  };
});

vi.mock("@/hooks/chats/use-chat-search-message-hits", () => ({
  useChatSearchMessageHits: (): ChatSearchMessageHitsStatus => {
    testState.hitsCalls += 1;
    return useSyncExternalStore(hitsStore.subscribe, hitsStore.read);
  },
}));

vi.mock("@/hooks/chats/use-chat-search-task-titles", () => ({
  useChatSearchTaskTitles: () => new Map<string, string>(),
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));

vi.mock("@/hooks/home/use-history-query", () => ({
  useHistoryQuery: () => {
    testState.historyQueryCalls += 1;
    return {
      data: {
        items: testState.items,
        availableRepos: [],
        availableWorkspaces: [],
        totalCount: testState.items.length,
        facets: { repos: [], workspaces: [], ownershipScopes: [] },
        worktreesByEpicId: new Map(),
        completeness: testState.completeness,
        chatHostFilterUnsupported: testState.chatHostFilterUnsupported,
        hostRequiresCloudToList: testState.hostRequiresCloudToList,
      },
      isPending: testState.isPending,
      isFetching: false,
      cloudPagePending: testState.cloudPagePending,
      error: testState.error,
      hostId: testState.hostId,
      refetch: testState.refetch,
      fetchNextPage: vi.fn(),
      hasNextPage: testState.hasNextPage,
      isFetchingNextPage: false,
    };
  },
}));

vi.mock("@/hooks/epic/use-epic-batch-delete-mutation", () => ({
  useEpicBatchDelete: () => ({ isPending: false, mutate: vi.fn() }),
  usePendingDeleteEpicIds: () => new Set<string>(),
}));

vi.mock("@/hooks/epic/use-task-delete-worktree-candidates-query", () => ({
  useTaskDeleteWorktreeCandidates: () => ({
    candidates: [],
    isError: false,
    isFetching: false,
  }),
}));

vi.mock("@/hooks/epic/use-epic-title-mutation", () => ({
  useEpicUpdateTitle: () => ({ isPending: false, mutate: vi.fn() }),
}));

vi.mock("@/hooks/epic/use-epic-set-pinned-mutation", () => ({
  useEpicSetPinned: () => ({ mutate: vi.fn() }),
  usePendingSetPinnedEpicIds: () => new Set<string>(),
}));

vi.mock("@/hooks/epic/use-epic-pin-local-home-support", () => ({
  useEpicPinLocalHomeSupported: () => false,
}));

vi.mock("@/hooks/epic/use-epic-activity-status", () => ({
  useEpicActivityStatus: (): "idle" => {
    testState.activityCalls += 1;
    return "idle";
  },
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

function messageMatch(chatId: string): ChatSearchMessageMatch {
  return {
    epicId: "epic-from-history",
    ownerUserId: "user-1",
    chatId,
    title: `Chat ${chatId}`,
    lifecycleState: "active",
    updatedAt: 1_700_000_000_000,
    matchCount: 1,
    best: {
      messageId: `${chatId}-m1`,
      tier: "assistant",
      createdAt: 1_700_000_000_000,
      interAgent: false,
      truncated: false,
      snippet: { text: "a matching line", highlights: [] },
    },
    messages: [],
  };
}

function readyHits(
  chatIds: ReadonlyArray<string>,
  more: boolean,
): ChatSearchMessageHitsStatus {
  return {
    kind: "ready",
    messages: chatIds.map(messageMatch),
    indexState: "complete",
    expansionBase: {
      query: "matching",
      scope: { kind: "all-accessible-tasks" },
      tiers: null,
      roleFilter: "any",
      dateRange: null,
      harness: null,
      mode: "ranked",
    },
    showMore: more ? () => {} : null,
    loadingMore: false,
    loadMoreError: null,
  };
}

function setHits(status: ChatSearchMessageHitsStatus): void {
  act(() => {
    hitsStore.box.status = status;
    for (const listener of hitsStore.listeners) listener();
  });
}

function setSearch(patch: Partial<HistorySearchState>): void {
  useHistorySearchStore.setState({
    search: { ...DEFAULT_HISTORY_SEARCH, ...patch },
  });
}

function RootOutlet(): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Outlet />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function renderScoped(initialScope: HistoryScope): {
  readonly onScopeSpy: (scope: HistoryScope) => void;
} {
  const onScopeSpy = vi.fn<(scope: HistoryScope) => void>();
  const rootRoute = createRootRoute({ component: () => <RootOutlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <ScopedEpicsListPanel
        initialScope={initialScope}
        onScopeSpy={onScopeSpy}
        variant="page"
        className={undefined}
        onSelectEpic={null}
        onOpenItem={null}
        routeSearch={null}
        historyNowMs={null}
        autoFocusSearch={false}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
  return { onScopeSpy };
}

function renderPicker(): void {
  const rootRoute = createRootRoute({ component: () => <RootOutlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <PickerEpicsListPanel
        className={undefined}
        onSelectEpic={null}
        onOpenItem={null}
        historyNowMs={null}
        autoFocusSearch={false}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
}

const TABS: Record<HistoryScope, string> = {
  all: "All",
  tasks: "Tasks",
  messages: "Messages",
};

function scopeTab(scope: HistoryScope): HTMLElement {
  const label = TABS[scope];
  const match = screen
    .getAllByRole("tab")
    .find((tab) => tab.textContent.startsWith(label));
  if (match === undefined) throw new Error(`no ${label} tab`);
  return match;
}

/** What a tab shows after its label: "2", "2+", "Searching" or "". */
function badgeOf(scope: HistoryScope): string {
  return scopeTab(scope).textContent.slice(TABS[scope].length);
}

function isSelected(scope: HistoryScope): boolean {
  return scopeTab(scope).getAttribute("aria-selected") === "true";
}

const taskLink = () =>
  screen.queryByRole("link", { name: "Open task Open from landing" });
const hitButton = () => screen.queryByRole("button", { name: /Chat chat-hit/ });
const messageRegion = () =>
  screen.queryByRole("region", { name: "Message matches" });
const tasksRegion = () => screen.queryByRole("region", { name: "Tasks" });
const searchBox = () =>
  screen.getByRole("searchbox", { name: "Search tasks and messages" });

/** A query long enough to be searched, and a client to search it with. */
function seedSearch(status: ChatSearchMessageHitsStatus): void {
  testState.chatSearchClient = stubChatSearchHostClient;
  hitsStore.box.status = status;
  setSearch({ query: "matching" });
}

beforeEach(() => {
  window.localStorage.clear();
  testState.items = [historyItem({})];
  testState.hostId = "host-test";
  testState.isPending = false;
  testState.cloudPagePending = false;
  testState.hasNextPage = false;
  testState.error = null;
  testState.completeness = null;
  testState.chatHostFilterUnsupported = false;
  testState.hostRequiresCloudToList = false;
  testState.refetch.mockReset();
  testState.refetch.mockResolvedValue(undefined);
  testState.historyQueryCalls = 0;
  testState.activityCalls = 0;
  testState.hitsCalls = 0;
  testState.chatSearchClient = null;
  hitsStore.box.status = { kind: "absent" };
  hitsStore.listeners.clear();
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  queryClient.clear();
  __resetTabNavigationControllerForTesting();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useHistorySearchStore.setState({ search: DEFAULT_HISTORY_SEARCH });
  useAuthStore.setState({ status: "signed-in" });
});

afterEach(() => {
  cleanup();
});

describe("History scope bar: structure", () => {
  it("is a labelled tablist of All, Tasks, Messages placed right after the search box", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("all");

    const list = await screen.findByRole("tablist", { name: "Search scope" });
    expect(
      screen
        .getAllByRole("tab")
        .map((tab) => tab.textContent.split(/\d|Searching/)[0]),
    ).toEqual(["All", "Tasks", "Messages"]);
    expect(
      searchBox().compareDocumentPosition(list) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByRole("tabpanel")).toBeTruthy();
    expect(isSelected("all")).toBe(true);
  });

  it("offers no Alt scope shortcuts", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("all");
    await screen.findByRole("tablist");

    for (const key of ["1", "2", "3"]) {
      fireEvent.keyDown(document.body, { key, altKey: true });
      fireEvent.keyDown(searchBox(), { key, altKey: true });
    }

    expect(isSelected("all")).toBe(true);
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.getAttribute("aria-keyshortcuts")).toBeNull();
    }
  });
});

describe("History scope bar: what each scope mounts", () => {
  it("All shows the task list and the message group together", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("all");

    expect(await screen.findByRole("tablist")).toBeTruthy();
    expect(taskLink()).not.toBeNull();
    expect(hitButton()).not.toBeNull();
    expect(messageRegion()).not.toBeNull();
    expect(tasksRegion()).not.toBeNull();
  });

  it("Tasks unmounts the message list but keeps counting messages", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("all");
    await screen.findByRole("tablist");
    const user = userEvent.setup();

    await user.click(scopeTab("tasks"));

    expect(isSelected("tasks")).toBe(true);
    expect(taskLink()).not.toBeNull();
    expect(messageRegion()).toBeNull();
    expect(hitButton()).toBeNull();
    // The controller still runs count-only, so the other tab stays truthful.
    expect(badgeOf("messages")).toBe("1");
    setHits(readyHits(["chat-hit", "chat-two"], false));
    expect(badgeOf("messages")).toBe("2");
  });

  it("Messages unmounts the task list but the task source stays live", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("all");
    await screen.findByRole("tablist");
    const user = userEvent.setup();

    await user.click(scopeTab("messages"));

    expect(isSelected("messages")).toBe(true);
    expect(taskLink()).toBeNull();
    expect(screen.queryByTestId("epics-list-rows")).toBeNull();
    expect(tasksRegion()).toBeNull();
    expect(hitButton()).not.toBeNull();
    // The Tasks badge is still fed by the live history query.
    expect(badgeOf("tasks")).toBe("1");
    const callsBefore = testState.historyQueryCalls;
    testState.hasNextPage = true;
    fireEvent.change(searchBox(), { target: { value: "matching " } });
    await waitFor(() => {
      expect(testState.historyQueryCalls).toBeGreaterThan(callsBefore);
    });
    expect(badgeOf("tasks")).toBe("1+");
  });

  it("switching scope is instant and back-and-forth keeps the query", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("all");
    await screen.findByRole("tablist");
    const user = userEvent.setup();

    await user.click(scopeTab("messages"));
    await user.click(scopeTab("tasks"));
    await user.click(scopeTab("all"));

    expect(taskLink()).not.toBeNull();
    expect(hitButton()).not.toBeNull();
    expect((searchBox() as HTMLInputElement).value).toBe("matching");
    expect(useHistorySearchStore.getState().search.query).toBe("matching");
  });
});

describe("History scope bar: arrow traversal follows what is visible", () => {
  it("in All walks the task row then the first hit", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("all");
    await screen.findByRole("tablist");
    const input = searchBox();
    input.focus();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(document.activeElement).toBe(taskLink());
    fireEvent.keyDown(taskLink() as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(hitButton());
  });

  it("in Tasks stops at the last task row - there is no hit to reach", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("tasks");
    await screen.findByRole("tablist");
    const input = searchBox();
    input.focus();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    const row = taskLink() as HTMLElement;
    expect(document.activeElement).toBe(row);
    fireEvent.keyDown(row, { key: "ArrowDown" });
    expect(document.activeElement).toBe(row);
  });

  it("in Messages goes straight from the box to the first hit", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("messages");
    await screen.findByRole("tablist");
    const input = searchBox();
    input.focus();

    fireEvent.keyDown(input, { key: "ArrowDown" });

    expect(document.activeElement).toBe(hitButton());
    fireEvent.keyDown(hitButton() as HTMLElement, { key: "ArrowUp" });
    expect(document.activeElement).toBe(input);
  });
});

describe("History scope bar: keyboard", () => {
  it("Tab from the search box reaches the tablist, skipping the desktop clear icon", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("all");
    await screen.findByRole("tablist");
    const user = userEvent.setup();

    const clear = screen.getByRole("button", { name: "Clear search" });
    expect(clear.tabIndex).toBe(-1);
    searchBox().focus();
    await user.tab();

    expect(document.activeElement).toBe(scopeTab("all"));
  });

  it("Left and Right move and activate, and Shift+Tab returns with the query intact", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    const { onScopeSpy } = renderScoped("all");
    await screen.findByRole("tablist");
    const user = userEvent.setup();
    searchBox().focus();
    await user.tab();

    await user.keyboard("{ArrowRight}");
    await waitFor(() => {
      expect(isSelected("tasks")).toBe(true);
    });
    expect(document.activeElement).toBe(scopeTab("tasks"));
    expect(onScopeSpy).toHaveBeenLastCalledWith("tasks");

    await user.keyboard("{ArrowRight}");
    await waitFor(() => {
      expect(isSelected("messages")).toBe(true);
    });
    expect(hitButton()).not.toBeNull();
    expect(taskLink()).toBeNull();

    await user.keyboard("{ArrowLeft}");
    await waitFor(() => {
      expect(isSelected("tasks")).toBe(true);
    });

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(searchBox());
    expect((searchBox() as HTMLInputElement).value).toBe("matching");
    expect(useHistorySearchStore.getState().search.query).toBe("matching");
  });
});

describe("History scope bar: task controls placement", () => {
  it.each<HistoryScope>(["all", "tasks"])(
    "%s carries Sort, Filter, Select and Refresh once, in the Tasks group header",
    async (scope) => {
      seedSearch(readyHits(["chat-hit"], false));
      renderScoped(scope);
      await screen.findByRole("tablist");

      const group = within(tasksRegion() as HTMLElement);
      for (const name of [
        /^Most recent|^Relevance/,
        /^Filter/,
        "Select history items",
        "Refresh tasks",
      ]) {
        expect(group.getAllByRole("button", { name })).toHaveLength(1);
        expect(screen.getAllByRole("button", { name })).toHaveLength(1);
      }
      expect(screen.queryByTestId("panel-chrome-bar")).toBeNull();
    },
  );

  it("Messages moves them inside the notice, and says why", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("messages");
    await screen.findByRole("tablist");

    const notice = screen.getByText("Filters and sort apply to tasks only.");
    const box = notice.closest("div");
    expect(box).not.toBeNull();
    const inside = within(box as HTMLElement);
    for (const name of [/^Filter/, "Select history items", "Refresh tasks"]) {
      expect(inside.getAllByRole("button", { name })).toHaveLength(1);
      expect(screen.getAllByRole("button", { name })).toHaveLength(1);
    }
    expect(tasksRegion()).toBeNull();
  });

  it("the picker keeps them in the top chrome bar with no scope bar", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    renderPicker();

    const chrome = await screen.findByTestId("panel-chrome-bar");
    expect(
      within(chrome).getByRole("button", { name: "Refresh tasks" }),
    ).toBeTruthy();
    expect(
      within(chrome).getByRole("button", { name: /^Filter/ }),
    ).toBeTruthy();
    expect(
      within(chrome).getByRole("searchbox", { name: "Search tasks" }),
    ).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(messageRegion()).toBeNull();
  });
});

describe("History scope bar: disabled task controls in Messages", () => {
  const CONTROLS: ReadonlyArray<string | RegExp> = [
    /^Oldest/,
    /^Filter/,
    "Select history items",
    "Refresh tasks",
  ];

  function seedNarrowedTasks(): void {
    seedSearch(readyHits(["chat-hit"], false));
    setSearch({
      query: "matching",
      sort: "oldest",
      sortExplicit: true,
      ownershipScopes: ["shared"],
    });
  }

  it("keeps all four focusable, aria-disabled and described by the notice", async () => {
    seedNarrowedTasks();
    renderScoped("messages");
    await screen.findByRole("tablist");

    for (const name of CONTROLS) {
      const button = screen.getByRole("button", { name });
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect((button as HTMLButtonElement).disabled).toBe(false);
      const describedBy = button.getAttribute("aria-describedby");
      expect(describedBy).not.toBeNull();
      expect(document.getElementById(describedBy ?? "")?.textContent).toContain(
        "Filters and sort apply to tasks only.",
      );
      button.focus();
      expect(document.activeElement).toBe(button);
    }
  });

  it("dispatches and opens nothing on click, Enter, Space or ArrowDown, and keeps every value", async () => {
    seedNarrowedTasks();
    const { onScopeSpy } = renderScoped("messages");
    await screen.findByRole("tablist");
    const user = userEvent.setup();

    for (const name of CONTROLS) {
      const button = screen.getByRole("button", { name });
      await user.click(button);
      button.focus();
      await user.keyboard("{Enter}");
      await user.keyboard(" ");
      await user.keyboard("{ArrowDown}");
    }

    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByTestId("epics-filter-popover")).toBeNull();
    expect(testState.refetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(isSelected("messages")).toBe(true);
    expect(onScopeSpy).not.toHaveBeenCalled();
    expect(useHistorySearchStore.getState().search).toMatchObject({
      sort: "oldest",
      sortExplicit: true,
      ownershipScopes: ["shared"],
      query: "matching",
    });
    expect(
      screen.getByText("Your task filters are kept and come back in Tasks."),
    ).toBeTruthy();
  });

  it("gives the values back, live, when the scope returns to Tasks", async () => {
    seedNarrowedTasks();
    renderScoped("messages");
    await screen.findByRole("tablist");
    const user = userEvent.setup();

    await user.click(scopeTab("tasks"));

    const sort = screen.getByRole("button", { name: /^Oldest/ });
    expect(sort.getAttribute("aria-disabled")).toBeNull();
    expect(sort.getAttribute("aria-describedby")).toBeNull();
    await user.click(sort);
    expect(await screen.findByRole("menu")).toBeTruthy();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Refresh tasks" }));
    await waitFor(() => {
      expect(testState.refetch).toHaveBeenCalledTimes(1);
    });
    expect(useHistorySearchStore.getState().search.sort).toBe("oldest");
  });

  it("names the narrowed-tasks caveat on the hits only in All", async () => {
    seedNarrowedTasks();
    renderScoped("all");
    await screen.findByRole("tablist");
    const user = userEvent.setup();
    const sentence =
      "History filters narrow tasks only. These matches come from this machine’s whole chat index.";

    expect(screen.getByText(sentence)).toBeTruthy();
    await user.click(scopeTab("messages"));
    expect(screen.queryByText(sentence)).toBeNull();
  });
});

describe("History scope bar: badges", () => {
  it("shows N on Tasks and Messages and never a badge on All", async () => {
    seedSearch(readyHits(["chat-hit", "chat-two"], false));
    renderScoped("all");
    await screen.findByRole("tablist");

    expect(badgeOf("all")).toBe("");
    expect(badgeOf("tasks")).toBe("1");
    expect(badgeOf("messages")).toBe("2");
  });

  it("shows N+ while a next cursor exists, for tasks and messages alike", async () => {
    testState.hasNextPage = true;
    seedSearch(readyHits(["chat-hit"], true));
    renderScoped("all");
    await screen.findByRole("tablist");

    expect(badgeOf("tasks")).toBe("1+");
    expect(badgeOf("messages")).toBe("1+");
  });

  it("shows the busy indicator, not a number, while a source is pending", async () => {
    testState.isPending = true;
    seedSearch({ kind: "loading" });
    renderScoped("all");
    await screen.findByRole("tablist");

    expect(badgeOf("tasks")).toBe("Searching");
    expect(badgeOf("messages")).toBe("Searching");
  });

  it("shows a real zero when a source was asked and found nothing", async () => {
    testState.items = [];
    seedSearch(readyHits([], false));
    renderScoped("all");
    await screen.findByRole("tablist");

    expect(badgeOf("tasks")).toBe("0");
    expect(badgeOf("messages")).toBe("0");
  });

  describe("Messages, when it could not be asked", () => {
    it("has no badge with no host client", async () => {
      seedSearch(readyHits(["chat-hit"], false));
      testState.chatSearchClient = null;
      renderScoped("all");
      await screen.findByRole("tablist");

      expect(badgeOf("messages")).toBe("");
      expect(badgeOf("tasks")).toBe("1");
    });

    it("has no badge after an error", async () => {
      seedSearch({ kind: "error", message: "The host went away." });
      renderScoped("all");
      await screen.findByRole("tablist");

      expect(badgeOf("messages")).toBe("");
      expect(badgeOf("tasks")).toBe("1");
    });

    it("has no badge when the source is absent", async () => {
      seedSearch({ kind: "absent" });
      renderScoped("all");
      await screen.findByRole("tablist");

      expect(badgeOf("messages")).toBe("");
    });

    it("has no badge below the two-character minimum, while Tasks still counts", async () => {
      seedSearch(readyHits(["chat-hit"], false));
      setSearch({ query: "m" });
      renderScoped("all");
      await screen.findByRole("tablist");

      expect(badgeOf("messages")).toBe("");
      expect(badgeOf("tasks")).toBe("1");
    });
  });

  describe("Tasks, when the list was refused", () => {
    const REFUSED: ReadonlyArray<{
      readonly name: string;
      readonly arrange: () => void;
    }> = [
      {
        name: "the cloud page is unavailable and nothing came back",
        arrange: () => {
          testState.items = [];
          testState.completeness = {
            cloudPage: "unavailable",
            facets: "partial",
            localRows: "truncated",
            sort: "loaded-union",
          };
        },
      },
      {
        name: "the query errored",
        arrange: () => {
          testState.error = new Error("boom");
        },
      },
      {
        name: "there is no host",
        arrange: () => {
          testState.hostId = null;
        },
      },
      {
        name: "the host needs the cloud to list",
        arrange: () => {
          testState.hostRequiresCloudToList = true;
        },
      },
      {
        name: "the host cannot apply the chat-host filter",
        arrange: () => {
          testState.chatHostFilterUnsupported = true;
        },
      },
    ];

    it.each(REFUSED)(
      "has no badge - never a false 0 - when $name",
      async (c) => {
        c.arrange();
        seedSearch(readyHits(["chat-hit"], false));
        renderScoped("all");
        await screen.findByRole("tablist");

        expect(badgeOf("tasks")).toBe("");
        expect(badgeOf("tasks")).not.toBe("0");
      },
    );

    it("says searching, not a number, while only the cloud page is pending", async () => {
      testState.cloudPagePending = true;
      seedSearch(readyHits(["chat-hit"], false));
      renderScoped("all");
      await screen.findByRole("tablist");

      expect(badgeOf("tasks")).toBe("Searching");
    });
  });

  it("shows no segment badges for an empty or blank query, all three still selectable", async () => {
    testState.chatSearchClient = stubChatSearchHostClient;
    hitsStore.box.status = readyHits(["chat-hit"], false);
    for (const query of ["", "   "]) {
      setSearch({ query });
      renderScoped("all");
      await screen.findByRole("tablist");
      const user = userEvent.setup();

      for (const scope of ["all", "tasks", "messages"] as const) {
        expect(badgeOf(scope)).toBe("");
        await user.click(scopeTab(scope));
        expect(isSelected(scope)).toBe(true);
      }
      cleanup();
    }
  });
});

describe("History scope bar: a message count landing", () => {
  it("re-renders neither the panel body nor the task rows", async () => {
    seedSearch({ kind: "loading" });
    renderScoped("all");
    await screen.findByRole("tablist");
    await waitFor(() => {
      expect(badgeOf("messages")).toBe("Searching");
    });
    const queryCalls = testState.historyQueryCalls;
    const activityCalls = testState.activityCalls;

    setHits(readyHits(["chat-hit", "chat-two"], false));
    await waitFor(() => {
      expect(badgeOf("messages")).toBe("2");
    });
    setHits(readyHits(["chat-hit", "chat-two"], true));
    await waitFor(() => {
      expect(badgeOf("messages")).toBe("2+");
    });

    expect(testState.historyQueryCalls).toBe(queryCalls);
    expect(testState.activityCalls).toBe(activityCalls);
  });
});

describe("History scope bar: selection mode", () => {
  it("forces Tasks by derivation and cancelling restores the prior scope", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    const { onScopeSpy } = renderScoped("all");
    await screen.findByRole("tablist");
    const user = userEvent.setup();

    await user.click(
      screen.getByRole("button", { name: "Select history items" }),
    );

    expect(isSelected("tasks")).toBe(true);
    expect(isSelected("all")).toBe(false);
    expect(messageRegion()).toBeNull();
    expect(taskLink()).toBeNull();
    // Rows are selectable in Tasks; the derived scope is never WRITTEN.
    expect(
      screen.getByRole("button", {
        name: "Toggle selection for Open from landing",
      }),
    ).toBeTruthy();
    expect(onScopeSpy).not.toHaveBeenCalled();
    // The message count keeps flowing so the tab stays truthful.
    expect(badgeOf("messages")).toBe("1");

    await user.click(scopeTab("messages"));
    expect(isSelected("tasks")).toBe(true);
    expect(onScopeSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(isSelected("all")).toBe(true);
    expect(hitButton()).not.toBeNull();
    expect(onScopeSpy).not.toHaveBeenCalled();
  });

  it("cancelling from Tasks stays on Tasks", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("tasks");
    await screen.findByRole("tablist");
    const user = userEvent.setup();

    await user.click(
      screen.getByRole("button", { name: "Select history items" }),
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(isSelected("tasks")).toBe(true);
  });
});

describe("History scope bar: the Messages pane without a searchable query", () => {
  it.each(["", "m"])(
    "says 'Type 2 characters to search messages' for %j and Show tasks goes back to Tasks",
    async (query) => {
      testState.chatSearchClient = stubChatSearchHostClient;
      hitsStore.box.status = readyHits(["chat-hit"], false);
      setSearch({ query });
      const { onScopeSpy } = renderScoped("messages");
      await screen.findByRole("tablist");
      const user = userEvent.setup();

      expect(
        screen.getByText("Type 2 characters to search messages"),
      ).toBeTruthy();
      expect(hitButton()).toBeNull();

      await user.click(screen.getByRole("button", { name: "Show tasks" }));

      expect(onScopeSpy).toHaveBeenCalledWith("tasks");
      expect(isSelected("tasks")).toBe(true);
      expect(taskLink()).not.toBeNull();
    },
  );

  it("says search is unavailable, rather than empty, when the index cannot be asked", async () => {
    testState.chatSearchClient = null;
    setSearch({ query: "matching" });
    renderScoped("messages");
    await screen.findByRole("tablist");

    expect(
      screen.getByText("Message search isn’t available on this machine"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show tasks" })).toBeTruthy();
  });

  it("deleting the query below the minimum does not change the scope", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    const { onScopeSpy } = renderScoped("messages");
    await screen.findByRole("tablist");

    fireEvent.change(searchBox(), { target: { value: "m" } });

    await waitFor(() => {
      expect(
        screen.getByText("Type 2 characters to search messages"),
      ).toBeTruthy();
    });
    expect(isSelected("messages")).toBe(true);
    expect(onScopeSpy).not.toHaveBeenCalled();

    fireEvent.change(searchBox(), { target: { value: "" } });
    expect(isSelected("messages")).toBe(true);
    expect(onScopeSpy).not.toHaveBeenCalled();
  });
});

describe("History scope bar: the message group's arrival", () => {
  it("fades in on first arrival in All but not when the scope is switched back to All", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("all");
    await screen.findByRole("tablist");
    const user = userEvent.setup();

    expect(messageRegion()?.className).toContain("starting:opacity-0");

    await user.click(scopeTab("tasks"));
    await user.click(scopeTab("all"));

    expect(messageRegion()?.className).not.toContain("starting:opacity-0");
  });

  it("never animates the standalone Messages pane", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("messages");
    await screen.findByRole("tablist");

    expect(messageRegion()?.className).not.toContain("starting:opacity-0");
  });
});
