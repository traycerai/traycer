/**
 * History's scope control end to end: the real `<EpicsListPanel>` (page and
 * picker) with only the host boundaries faked. What lives here is what the
 * panel suite and the message-hits suite cannot see alone - which lists are
 * mounted per scope, the keyboard path through the tab bar, the per-scope
 * search box, the group headers, the task controls that only exist in a
 * task scope, the truthful badges, and selection mode.
 */
import "./stub-sweep-dialog-host-hooks";

import type { ListTasksCompleteness } from "@traycer/protocol/host/epic/unary-schemas";
import type { ChatSearchMessageMatch } from "@traycer/protocol/host/chat-search/schemas";
import type { ChatSearchMessageHitsStatus } from "@/hooks/chats/use-chat-search-message-hits";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "dark" }),
}));

// The in-progress lift (`useInProgressHistoryItems`) backfills a running task
// no listed page carries through `epic.getTaskContexts`, which needs a host
// runtime this suite deliberately does not mount. Inert here: nothing is
// running in these fixtures, so the lift has nothing to lift either way.
vi.mock("@/hooks/epic/use-epic-get-task-contexts-query", () => ({
  useEpicGetTaskContexts: () => ({
    tasksById: new Map(),
    localHomedTaskIds: new Set<string>(),
    isFetching: false,
    error: null,
  }),
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
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PickerEpicsListPanel } from "@/components/epics/epics-list-panel";
import { ScopedEpicsListPanel } from "./scoped-panel-harness";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Dialog as DialogPrimitive } from "radix-ui";
import { SystemTabModalSurface } from "@/components/layout/dialogs/system-tab-modal-host";
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
  // The projected-but-provisional state (debounce / placeholder handoff),
  // where `isPending` is false yet the count is not yet the answer.
  isCountPending: false,
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
  hostEntry: null as HostDirectoryEntry | null,
}));

// The measured header height lives outside React for the same reason: a test
// can resize a header without re-rendering anything above it, which is the
// path the panel has to absorb (the real hook is a ResizeObserver, which
// jsdom cannot drive, and jsdom has no layout to measure anyway).
const headerHeights = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const box = { height: 0 };
  return {
    box,
    listeners,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    read: (): number => box.height,
  };
});

vi.mock("@/hooks/ui/use-measured-element-height", () => ({
  useMeasuredElementHeight: () => {
    const [element, setElement] = useState<HTMLDivElement | null>(null);
    const height = useSyncExternalStore(
      headerHeights.subscribe,
      headerHeights.read,
    );
    return { element, setElement, height };
  },
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
  useHostDirectoryEntry: () => testState.hostEntry,
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
      // The real hook's count-pending is a superset of both flags.
      isCountPending:
        testState.isCountPending ||
        testState.isPending ||
        testState.cloudPagePending,
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

/**
 * The History MODAL as the app builds it: the real system-modal surface (frame,
 * `onEscapeKeyDown` -> `overlayConsumesEscape`, `HistoryModalContent`) inside a
 * real Radix Dialog root, so Radix's capture-phase Escape listener is in play.
 */
function renderInModal(onClose: () => void): void {
  const rootRoute = createRootRoute({ component: () => <RootOutlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <DialogPrimitive.Root
        open
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
      >
        <SystemTabModalSurface
          active={{ kind: "history", section: null }}
          editingTheme={false}
          onClose={onClose}
          onPromote={() => undefined}
        />
      </DialogPrimitive.Root>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
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
// The Messages heading carries the host, and the region is labelled by it, so
// the region's name is "Message matches" plus the host label.
const messageRegion = () =>
  screen.queryByRole("region", { name: /^Message matches/ });
const tasksRegion = () => screen.queryByRole("region", { name: "Tasks" });
const messagesHeading = () => screen.queryByRole("heading", { level: 3 });
const tasksHeading = () => screen.queryByRole("heading", { level: 2 });
/** The desktop page has exactly one search box, whatever its per-scope name. */
const searchBox = () => screen.getByRole("searchbox");
/** The scroller both group headers and both regions are direct children of. */
const scroller = (): HTMLElement => {
  const parent = (messageRegion() ?? tasksRegion())?.parentElement;
  if (parent === null || parent === undefined) throw new Error("no scroller");
  return parent;
};
/** The scope bar's sr-only live status: the scroller's first child. */
const scopeStatus = (): HTMLElement => {
  const node = scroller().firstElementChild;
  if (!(node instanceof HTMLElement) || node.getAttribute("role") !== "status")
    throw new Error("the scope bar status is not the scroller's first child");
  return node;
};

const TANVEER_HOST: HostDirectoryEntry = {
  hostId: "host-test",
  label: "Tanveer's MacBook",
  kind: "local",
  websocketUrl: null,
  version: null,
  transportDialability: "dialable",
};

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
  testState.isCountPending = false;
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
  testState.hostEntry = null;
  headerHeights.box.height = 0;
  headerHeights.listeners.clear();
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

  it("puts the search box and the tablist in one row, box first, with the results below it", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("all");
    const list = await screen.findByRole("tablist", { name: "Search scope" });
    const user = userEvent.setup();
    const box = searchBox();

    const row = list.closest("[data-history-search-row]");
    if (row === null) throw new Error("the tablist is not in the search row");
    expect(row.contains(box)).toBe(true);
    expect(
      box.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const below = [screen.getByRole("tabpanel"), scroller()];
    for (const node of below) {
      expect(row.contains(node)).toBe(false);
      expect(
        row.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }

    // Scope changes swap the panel, never the row: same box, same row.
    await user.click(scopeTab("messages"));
    expect(searchBox()).toBe(box);
    expect(row.contains(box)).toBe(true);
    expect(row.contains(screen.getByRole("tablist"))).toBe(true);
  });

  it("slides the indicator across the 1:2:3 columns and keeps the compact sizing", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("all");
    const list = await screen.findByRole("tablist", { name: "Search scope" });
    const user = userEvent.setup();
    const indicator = (): HTMLElement => {
      const node = list.querySelector<HTMLElement>(
        '[data-slot="tabs-indicator"]',
      );
      if (node === null) throw new Error("no scope indicator");
      return node;
    };

    expect(list.className).toContain("grid-cols-[1fr_2fr_3fr]");
    expect(list.className).toContain("h-8");
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.className).toContain("min-h-7");
    }

    // Width is (index + 1) / 6 of the inner row, offset by index * 50% of
    // its own width: the left edge lands on 0, 1/6 and 1/2 of the row.
    const cases: ReadonlyArray<readonly [HistoryScope, number, string]> = [
      ["all", 1 / 6, "translateX(0%)"],
      ["tasks", 2 / 6, "translateX(50%)"],
      ["messages", 3 / 6, "translateX(100%)"],
    ];
    for (const [scope, fraction, transform] of cases) {
      await user.click(scopeTab(scope));
      const node = indicator();
      // jsdom serializes the product with the factor first.
      expect(node.style.width).toBe(`calc(${fraction} * (100% - 4px))`);
      expect(node.style.transform).toBe(transform);
      expect(node.className).toContain("transition-[transform,width]");
      expect(node.className).toContain("duration-160");
      expect(node.className).toContain("motion-reduce:transition-none");
    }
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

      const header = tasksHeading()?.parentElement;
      if (header === null || header === undefined) throw new Error("no header");
      const group = within(header);
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

  it("Messages renders none of them, and no notice in their place", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("messages");
    await screen.findByRole("tablist");

    for (const name of [
      /^Most recent|^Relevance/,
      /^Filter/,
      "Select history items",
      "Refresh tasks",
    ]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(tasksRegion()).toBeNull();
    expect(tasksHeading()).toBeNull();
    expect(screen.queryByText(/apply to tasks only/)).toBeNull();
    expect(screen.queryByText(/come back in Tasks/)).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
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
    expect(
      within(chrome).getByPlaceholderText(
        "Search by title, repo, branch, or PR",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(messageRegion()).toBeNull();
  });
});

describe("History scope bar: task controls in Messages", () => {
  function seedNarrowedTasks(): void {
    seedSearch(readyHits(["chat-hit"], false));
    setSearch({
      query: "matching",
      sort: "oldest",
      sortExplicit: true,
      ownershipScopes: ["shared"],
    });
  }

  it("keeps every task value while the controls are gone", async () => {
    seedNarrowedTasks();
    const { onScopeSpy } = renderScoped("all");
    await screen.findByRole("tablist");
    const user = userEvent.setup();

    await user.click(scopeTab("messages"));

    expect(screen.queryByRole("button", { name: /^Oldest/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Filter/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh tasks" })).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(testState.refetch).not.toHaveBeenCalled();
    expect(onScopeSpy).toHaveBeenLastCalledWith("messages");
    expect(useHistorySearchStore.getState().search).toMatchObject({
      sort: "oldest",
      sortExplicit: true,
      ownershipScopes: ["shared"],
      query: "matching",
    });
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
    expect(
      screen
        .getByRole("button", { name: /^Filter/ })
        .getAttribute("aria-disabled"),
    ).toBeNull();
  });
});

describe("History scope bar: the filters line", () => {
  const LINE = "Filters apply to tasks only.";

  function seedFilters(active: boolean): void {
    seedSearch(readyHits(["chat-hit"], false));
    setSearch({
      query: "matching",
      ownershipScopes: active ? ["shared"] : [],
    });
  }

  it.each<HistoryScope>(["all", "messages"])(
    "is one muted line under %s while a task filter is active",
    async (scope) => {
      seedFilters(true);
      renderScoped(scope);
      await screen.findByRole("tablist");

      const line = screen.getByText(LINE);
      expect(line.tagName).toBe("P");
      expect(line.className).toContain("text-muted-foreground");
      expect(line.querySelector("svg")).toBeNull();
      expect(document.body.textContent).not.toContain("whole chat index");
      expect(document.body.textContent).not.toContain(
        "Your task filters are kept",
      );
    },
  );

  it("is absent under Tasks, where the filters simply apply", async () => {
    seedFilters(true);
    renderScoped("tasks");
    await screen.findByRole("tablist");

    expect(screen.queryByText(LINE)).toBeNull();
  });

  it.each<HistoryScope>(["all", "messages"])(
    "is absent under %s while no task filter is active",
    async (scope) => {
      seedFilters(false);
      renderScoped(scope);
      await screen.findByRole("tablist");

      expect(screen.queryByText(LINE)).toBeNull();
    },
  );

  it("comes and goes with the filter and the scope", async () => {
    seedFilters(true);
    renderScoped("all");
    await screen.findByRole("tablist");
    const user = userEvent.setup();

    expect(screen.getAllByText(LINE)).toHaveLength(1);
    await user.click(scopeTab("messages"));
    expect(screen.getAllByText(LINE)).toHaveLength(1);
    await user.click(scopeTab("tasks"));
    expect(screen.queryByText(LINE)).toBeNull();
    act(() => {
      setSearch({ query: "matching", ownershipScopes: [] });
    });
    await user.click(scopeTab("all"));
    expect(screen.queryByText(LINE)).toBeNull();
  });
});

describe("History search: Escape with a non-empty query", () => {
  async function focusedBox(): Promise<HTMLInputElement> {
    await screen.findByRole("tablist");
    const box = searchBox();
    if (!(box instanceof HTMLInputElement)) throw new Error("no search input");
    act(() => {
      box.focus();
    });
    return box;
  }

  it("in the modal, clears the query and keeps the modal open; the next Escape closes it", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    const onClose = vi.fn<() => void>();
    renderInModal(onClose);
    const box = await focusedBox();
    expect(box.value).toBe("matching");
    const user = userEvent.setup();

    // Radix listens for Escape in the capture phase on the document, so it sees
    // this key before any `onKeyDown` on the input.
    await user.keyboard("{Escape}");

    expect((searchBox() as HTMLInputElement).value).toBe("");
    expect(useHistorySearchStore.getState().search.query).toBe("");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();

    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalled();
  });

  it("in the modal's selection mode, Escape is unchanged: it closes and leaves the query alone", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    const onClose = vi.fn<() => void>();
    renderInModal(onClose);
    await screen.findByRole("tablist");
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Select history items" }),
    );
    await focusedBox();

    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalled();
    expect(useHistorySearchStore.getState().search.query).toBe("matching");
  });

  it("in the promoted tab, clears the query", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("all");
    const box = await focusedBox();
    const user = userEvent.setup();

    await user.keyboard("{Escape}");

    expect(box.value).toBe("");
    expect(useHistorySearchStore.getState().search.query).toBe("");
  });
});

describe("History scope bar: the search box follows the scope", () => {
  const ALL = "Search tasks and messages";
  const TASKS = "Search by title, repo, branch, or PR";

  it("names its purpose, as placeholder and label, per scope", async () => {
    testState.hostEntry = TANVEER_HOST;
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("all");
    await screen.findByRole("tablist");
    const user = userEvent.setup();
    const box = searchBox();

    const expectName = (name: string): void => {
      expect(box.getAttribute("placeholder")).toBe(name);
      expect(box.getAttribute("aria-label")).toBe(name);
    };
    expectName(ALL);
    await user.click(scopeTab("tasks"));
    expectName(TASKS);
    await user.click(scopeTab("messages"));
    expectName("Search messages on Tanveer's MacBook");
    await user.click(scopeTab("all"));
    expectName(ALL);
    // The same input throughout: focus and the typed value ride through.
    expect(searchBox()).toBe(box);
    expect((box as HTMLInputElement).value).toBe("matching");
  });

  it("falls back to this machine when the host has no label", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("messages");
    await screen.findByRole("tablist");

    expect(
      screen.getByRole("searchbox", {
        name: "Search messages on this machine",
      }),
    ).toBeTruthy();
  });

  it("keeps a typed query and its focus across scope changes", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("all");
    await screen.findByRole("tablist");
    const user = userEvent.setup();
    const box = searchBox();
    fireEvent.change(box, { target: { value: "matching more" } });

    await user.click(scopeTab("messages"));
    await user.click(scopeTab("tasks"));

    expect(searchBox()).toBe(box);
    expect((box as HTMLInputElement).value).toBe("matching more");
    expect(useHistorySearchStore.getState().search.query).toBe("matching more");
  });

  it("reads the Tasks wording, not the scope, while selecting", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    // Messages has no Select control; from All the derived scope is Tasks.
    renderScoped("all");
    await screen.findByRole("tablist");
    const user = userEvent.setup();

    await user.click(
      screen.getByRole("button", { name: "Select history items" }),
    );

    expect(searchBox().getAttribute("placeholder")).toBe(TASKS);
    expect(searchBox().getAttribute("aria-label")).toBe(TASKS);
  });

  it("leaves the picker's task-only wording alone", async () => {
    testState.hostEntry = TANVEER_HOST;
    seedSearch(readyHits(["chat-hit"], false));
    renderPicker();

    const box = await screen.findByRole("searchbox", { name: "Search tasks" });
    expect(box.getAttribute("placeholder")).toBe(TASKS);
  });
});

describe("History scope bar: the group headers", () => {
  const scrollIntoView = vi.fn<(options: ScrollIntoViewOptions) => void>();
  const nativeScrollIntoView = Reflect.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollIntoView",
  );
  let reducedMotion = false;

  beforeEach(() => {
    scrollIntoView.mockReset();
    reducedMotion = false;
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
    vi.stubGlobal("matchMedia", (query: string) => ({
      // Only the reduced-motion query is ever true; the panel's own mobile
      // viewport query must keep answering "desktop".
      matches:
        query === "(prefers-reduced-motion: reduce)" ? reducedMotion : false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (nativeScrollIntoView === undefined) {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    } else {
      Object.defineProperty(
        Element.prototype,
        "scrollIntoView",
        nativeScrollIntoView,
      );
    }
  });

  it("nests the Tasks header in its isolated region; the Messages header is a direct sibling before its own", async () => {
    testState.hostEntry = TANVEER_HOST;
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("all");
    await screen.findByRole("tablist");

    const tasksHeader = tasksHeading()?.parentElement;
    const messagesHeader = messagesHeading()?.parentElement;
    // Tasks: header INSIDE the labelled section, so it is bounded by it.
    expect(tasksHeader?.parentElement).toBe(tasksRegion());
    expect(tasksRegion()?.firstElementChild).toBe(tasksHeader);
    expect(tasksRegion()?.parentElement).toBe(scroller());
    // Messages: header is a direct child of the scroller, then its region.
    expect(messagesHeader?.parentElement).toBe(scroller());
    expect(messagesHeader?.nextElementSibling).toBe(messageRegion());
    expect(messageRegion()?.parentElement).toBe(scroller());
    // Tasks first, then Messages, in reading order.
    expect(
      tasksRegion()?.compareDocumentPosition(messagesHeader as HTMLElement) ??
        0,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("isolates the Tasks region, its row content and the Messages region separately", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("all");
    await screen.findByRole("tablist");

    // Outer layer: the group cannot outstack the Messages header.
    expect(tasksRegion()?.classList.contains("isolate")).toBe(true);
    expect(tasksRegion()?.className).toContain("pb-6");
    expect(messageRegion()?.classList.contains("isolate")).toBe(true);
    // Inner layer: row z-10 descendants cannot outstack the Tasks header.
    const rowLayer = (taskLink() as HTMLElement).closest(".isolate");
    expect(rowLayer).not.toBeNull();
    expect(rowLayer).not.toBe(tasksRegion());
    expect(rowLayer?.parentElement).toBe(tasksRegion());
    expect(rowLayer?.previousElementSibling).toBe(
      tasksHeading()?.parentElement,
    );
    expect(rowLayer?.contains(tasksHeading() as HTMLElement)).toBe(false);
    // The Tasks target includes its own header: no scroll offset.
    expect(tasksRegion()?.className).not.toContain("scroll-m");
  });

  it("draws one divider: no scroller border, and only the Messages header owns a top border", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("all");
    await screen.findByRole("tablist");

    expect(scroller().className).not.toMatch(/(^|\s)border(-|\s|$)/);
    expect(scroller().className).not.toContain("border-t");
    expect(messagesHeading()?.parentElement?.className).toContain("border-t");
    expect(tasksHeading()?.parentElement?.className).not.toContain("border-t");
    cleanup();

    renderScoped("messages");
    await screen.findByRole("tablist");
    expect(scroller().className).not.toContain("border-t");
    expect(messagesHeading()?.parentElement?.className).toContain("border-t");
  });

  it("labels each region by its heading, and the Messages heading names the host", async () => {
    testState.hostEntry = TANVEER_HOST;
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("all");
    await screen.findByRole("tablist");

    expect(tasksRegion()?.getAttribute("aria-labelledby")).toBe(
      tasksHeading()?.id,
    );
    expect(messageRegion()?.getAttribute("aria-labelledby")).toBe(
      messagesHeading()?.id,
    );
    expect(
      screen.getByRole("heading", {
        level: 3,
        name: "Message matches Tanveer's MacBook",
      }),
    ).toBe(messagesHeading());
    expect(
      screen.getByRole("region", { name: "Message matches Tanveer's MacBook" }),
    ).toBe(messageRegion());
    expect(tasksHeading()?.textContent).toBe("Tasks");
  });

  it("pins Tasks to the top; Messages to the top and bottom in All, the top alone standalone", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("all");
    await screen.findByRole("tablist");
    const user = userEvent.setup();

    expect(tasksHeading()?.parentElement?.className).toContain("top-0");
    expect(tasksHeading()?.parentElement?.className).not.toContain("bottom-0");
    expect(messagesHeading()?.parentElement?.className).toContain("top-0");
    expect(messagesHeading()?.parentElement?.className).toContain("bottom-0");

    await user.click(scopeTab("messages"));
    expect(messagesHeading()?.parentElement?.className).toContain("top-0");
    expect(messagesHeading()?.parentElement?.className).not.toContain(
      "bottom-0",
    );
  });

  it("gives sticky headers no margin and no focus z-index escape", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("all");
    await screen.findByRole("tablist");
    const user = userEvent.setup();

    const assertClean = (): void => {
      for (const heading of [tasksHeading(), messagesHeading()]) {
        const className = heading?.parentElement?.className;
        if (className === undefined) continue;
        expect(className).not.toMatch(/(^|\s)-?m[trblxys]?-/);
        expect(className).not.toContain("z-30");
        expect(className).not.toContain("focus-visible:z");
      }
    };
    assertClean();
    await user.click(scopeTab("messages"));
    assertClean();
  });

  it("scrolls the Messages region to its start when its label is pressed", async () => {
    testState.hostEntry = TANVEER_HOST;
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("all");
    await screen.findByRole("tablist");
    const user = userEvent.setup();

    await user.click(
      within(messagesHeading() as HTMLElement).getByRole("button", {
        name: /^Message matches/,
      }),
    );

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "start",
      behavior: "smooth",
    });
    expect(scrollIntoView.mock.contexts[0]).toBe(messageRegion());
  });

  it("scrolls the Tasks region to its start, instantly under reduced motion", async () => {
    reducedMotion = true;
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("all");
    await screen.findByRole("tablist");
    const user = userEvent.setup();

    await user.click(
      within(tasksHeading() as HTMLElement).getByRole("button", {
        name: "Tasks",
      }),
    );

    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "start",
      behavior: "instant",
    });
    expect(scrollIntoView.mock.contexts[0]).toBe(tasksRegion());
  });

  it("draws no Messages header, and no Tasks-only header state, where it has no group", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("tasks");
    await screen.findByRole("tablist");
    // Tasks: the group is count-only.
    expect(messagesHeading()).toBeNull();
    expect(messageRegion()).toBeNull();
    expect(tasksHeading()).not.toBeNull();
    cleanup();

    // The source is absent: nothing to head.
    seedSearch({ kind: "absent" });
    renderScoped("all");
    await screen.findByRole("tablist");
    expect(messagesHeading()).toBeNull();
    expect(messageRegion()).toBeNull();
    expect(tasksHeading()).not.toBeNull();
  });

  it("draws no Messages header under All while the task list is still unsettled", async () => {
    testState.isPending = true;
    seedSearch({ kind: "loading" });
    renderScoped("all");
    await screen.findByRole("tablist");

    expect(messagesHeading()).toBeNull();
    expect(messageRegion()).toBeNull();
    // Standalone it does not wait for the task list, which it does not show.
    cleanup();
    renderScoped("messages");
    await screen.findByRole("tablist");
    expect(messagesHeading()).not.toBeNull();
  });

  it("is not a row stop: ArrowDown and ArrowUp walk task rows and hits only", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("all");
    await screen.findByRole("tablist");
    const input = searchBox();
    input.focus();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(document.activeElement).toBe(taskLink());
    fireEvent.keyDown(taskLink() as HTMLElement, { key: "ArrowDown" });
    // Past the Messages header label, straight onto the hit.
    expect(document.activeElement).toBe(hitButton());
    fireEvent.keyDown(hitButton() as HTMLElement, { key: "ArrowUp" });
    expect(document.activeElement).toBe(taskLink());
    for (const header of [tasksHeading(), messagesHeading()]) {
      const label = header?.querySelector("button");
      expect(label?.hasAttribute("data-history-row-target")).toBe(false);
      expect(label?.hasAttribute("data-chat-search-nav")).toBe(false);
    }
  });

  it("writes each header's measured height onto the scroller, and only there", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("all");
    await screen.findByRole("tablist");

    expect(
      scroller().style.getPropertyValue("--history-tasks-header-height"),
    ).toBe("");
    act(() => {
      headerHeights.box.height = 48;
      for (const listener of headerHeights.listeners) listener();
    });
    expect(
      scroller().style.getPropertyValue("--history-tasks-header-height"),
    ).toBe("48px");
    expect(
      scroller().style.getPropertyValue("--history-messages-header-height"),
    ).toBe("48px");

    // A header that leaves takes its property with it.
    const user = userEvent.setup();
    await user.click(scopeTab("tasks"));
    expect(
      scroller().style.getPropertyValue("--history-messages-header-height"),
    ).toBe("");
    expect(
      scroller().style.getPropertyValue("--history-tasks-header-height"),
    ).toBe("48px");

    // Both headers clean up on unmount, the nested Tasks header included.
    const mounted = scroller();
    expect(mounted.hasAttribute("data-history-scroll")).toBe(true);
    cleanup();
    expect(
      mounted.style.getPropertyValue("--history-tasks-header-height"),
    ).toBe("");
    expect(
      mounted.style.getPropertyValue("--history-messages-header-height"),
    ).toBe("");
  });

  it("marks the one scroller, and the nested Tasks header still writes to it", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("tasks");
    await screen.findByRole("tablist");

    const marked = document.querySelectorAll("[data-history-scroll]");
    expect(marked).toHaveLength(1);
    expect(marked[0]).toBe(scroller());
    // The Tasks header is not a direct child of the scroller.
    expect(tasksHeading()?.parentElement?.parentElement).not.toBe(scroller());
    act(() => {
      headerHeights.box.height = 52;
      for (const listener of headerHeights.listeners) listener();
    });
    expect(
      scroller().style.getPropertyValue("--history-tasks-header-height"),
    ).toBe("52px");
  });

  it("re-renders neither the panel body nor the task rows when a header resizes", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("all");
    await screen.findByRole("tablist");
    const queryCalls = testState.historyQueryCalls;
    const activityCalls = testState.activityCalls;
    const hitsCalls = testState.hitsCalls;

    for (const height of [48, 64, 40]) {
      act(() => {
        headerHeights.box.height = height;
        for (const listener of headerHeights.listeners) listener();
      });
    }

    expect(
      scroller().style.getPropertyValue("--history-tasks-header-height"),
    ).toBe("40px");
    expect(testState.historyQueryCalls).toBe(queryCalls);
    expect(testState.activityCalls).toBe(activityCalls);
    expect(testState.hitsCalls).toBe(hitsCalls);
  });
});

describe("History scope bar: the sr-only status", () => {
  it("is one visually hidden polite node holding the counts, and no visible count line", async () => {
    testState.hostEntry = TANVEER_HOST;
    seedSearch(readyHits(["chat-hit", "chat-two"], false));
    renderScoped("all");
    await screen.findByRole("tablist");

    const status = scopeStatus();
    expect(status.className).toContain("sr-only");
    expect(status.textContent).toBe(
      "1 task · 2 chats with message matches on Tanveer's MacBook",
    );
    // No Tasks heading badge, no visible message count anywhere in a header.
    expect(tasksHeading()?.parentElement?.textContent).not.toMatch(/\d/);
    expect(messagesHeading()?.parentElement?.textContent).not.toMatch(/\d/);
  });

  it("is the same node as counts change and scopes switch, and still updates", async () => {
    seedSearch({ kind: "loading" });
    renderScoped("all");
    await screen.findByRole("tablist");
    const user = userEvent.setup();
    const status = scopeStatus();
    await waitFor(() => {
      expect(status.textContent).toContain("Searching");
    });

    setHits(readyHits(["chat-hit"], false));
    expect(scopeStatus()).toBe(status);
    expect(status.textContent).toBe(
      "1 task · 1 chat with message matches on this machine",
    );

    setHits(readyHits(["chat-hit", "chat-two"], true));
    expect(status.textContent).toBe(
      "1 task · 2+ chats with message matches on this machine",
    );

    await user.click(scopeTab("messages"));
    expect(scopeStatus()).toBe(status);
    expect(status.textContent).toBe(
      "2+ chats with message matches on this machine",
    );

    await user.click(scopeTab("tasks"));
    expect(scopeStatus()).toBe(status);
    expect(status.textContent).toBe("1 task");

    await user.click(scopeTab("all"));
    expect(scopeStatus()).toBe(status);
    expect(status.textContent).toContain("2+ chats");
  });

  it("has no ScopeNote and repeats no count in visible text", async () => {
    seedSearch(readyHits(["chat-hit"], false));
    setSearch({ query: "matching", ownershipScopes: ["shared"] });
    renderScoped("all");
    await screen.findByRole("tablist");

    expect(screen.queryByText(/come back in Tasks/)).toBeNull();
    expect(screen.queryByText(/whole chat index/)).toBeNull();
    // Counts are visible on the pills alone.
    expect(badgeOf("tasks")).toBe("1");
    expect(badgeOf("messages")).toBe("1");
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

  it("says searching, never a settled 0 or a complete N, while the projection is provisional", async () => {
    testState.items = [];
    testState.isCountPending = true;
    seedSearch(readyHits(["chat-hit"], false));
    renderScoped("all");
    await screen.findByRole("tablist");

    expect(badgeOf("tasks")).toBe("Searching");
    expect(badgeOf("tasks")).not.toBe("0");
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
    testState.hostEntry = TANVEER_HOST;
    setSearch({ query: "matching" });
    const { onScopeSpy } = renderScoped("messages");
    await screen.findByRole("tablist");
    const user = userEvent.setup();

    const line = screen.getByText("Message search isn't available right now.");
    // One line and one way out: no host, no second explanation.
    expect(line.parentElement?.textContent).toBe(
      "Message search isn't available right now.Show tasks",
    );
    expect(messagesHeading()).toBeNull();

    await user.click(screen.getByRole("button", { name: "Show tasks" }));
    expect(onScopeSpy).toHaveBeenCalledWith("tasks");
  });

  it("says nothing about the missing index under All", async () => {
    testState.chatSearchClient = null;
    setSearch({ query: "matching" });
    renderScoped("all");
    await screen.findByRole("tablist");

    expect(screen.queryByText(/Message search/)).toBeNull();
    expect(messagesHeading()).toBeNull();
    expect(tasksRegion()).not.toBeNull();
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
