import "../../../../__tests__/test-browser-apis";

vi.mock("@/hooks/notifications/use-host-notification-indicators-query", () => ({
  useHostNotificationIndicators: () => ({
    data: { epics: {}, chats: {} },
    isPending: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
  }),
}));

const tabNavigationMocks = vi.hoisted(() => ({
  activateTabIntent: vi.fn(),
}));

// Only `activateTabIntent` is replaced with a spy so we can observe HOW the
// Phase row opens without changing the controller's real behavior; every
// other export (notably `tabNavigationController` and `openOrFocusEpicIntent`,
// used both by production and to build the expected call args below) stays
// the real implementation via `importActual`.
vi.mock("@/lib/tab-navigation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tab-navigation")>(
    "@/lib/tab-navigation",
  );
  return {
    ...actual,
    activateTabIntent: tabNavigationMocks.activateTabIntent,
  };
});

import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type {
  NavigateOptions,
  UseNavigateResult,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EpicsListPanel } from "@/components/epics/epics-list-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useHistorySearchStore } from "@/stores/home/history-search-store";
import { DEFAULT_HISTORY_SEARCH } from "@/lib/history-search";
import {
  __resetTabNavigationControllerForTesting,
  openOrFocusEpicIntent,
  tabNavigationController,
} from "@/lib/tab-navigation";
import { flattenLayoutRefs, tabItemId } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";

/**
 * F-phase: opening a legacy Phase row from the epics list must route through
 * the canonical activation boundary (`activateTabIntent` carrying an
 * `open-epic` intent with `focus.migrationSource: "phase"`) instead of a raw
 * mutating navigate over a route builder - so a rejected phase navigation can
 * roll back to the tab the user actually started on, the same guarantee every
 * other opener in this boundary gets (see
 * `src/lib/tab-navigation/__tests__/navigation-envelope.test.ts`'s
 * "rejecting an open-epic-from-list navigation restores the genuine prior
 * tab").
 */

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

const testState = vi.hoisted(() => ({
  items: [] as HistoryItem[],
  refetch: vi.fn(),
  fetchNextPage: vi.fn(),
}));

vi.mock("@/hooks/home/use-history-query", () => ({
  useHistoryQuery: () => ({
    data: {
      items: testState.items,
      availableRepos: [],
      availableWorkspaces: [],
      totalCount: testState.items.length,
      facets: { repos: [], workspaces: [], ownershipScopes: [] },
      worktreesByEpicId: new Map(),
    },
    isPending: false,
    isFetching: false,
    error: null,
    hostId: "host-test",
    refetch: testState.refetch,
    fetchNextPage: testState.fetchNextPage,
    hasNextPage: false,
    isFetchingNextPage: false,
  }),
}));

vi.mock("@/hooks/epic/use-epic-batch-delete-mutation", () => ({
  useEpicBatchDelete: () => ({ isPending: false, mutate: vi.fn() }),
}));

vi.mock("@/hooks/epic/use-task-delete-worktree-candidates-query", () => ({
  useTaskDeleteWorktreeCandidates: () => ({ candidates: [], isError: false }),
}));

vi.mock("@/hooks/epic/use-epic-title-mutation", () => ({
  useEpicUpdateTitle: () => ({ isPending: false, mutate: vi.fn() }),
}));

vi.mock("@/hooks/epic/use-epic-set-pinned-mutation", () => ({
  useEpicSetPinned: () => ({ mutate: vi.fn() }),
  usePendingSetPinnedEpicIds: () => new Set<string>(),
}));

vi.mock("@/hooks/epic/use-epic-activity-status", () => ({
  useEpicActivityStatus: () => "idle" as const,
}));

const PHASE_EPIC_ID = "phase-open-target";

function phaseHistoryItem(): HistoryItem {
  return {
    id: "history-phase-open",
    epicId: PHASE_EPIC_ID,
    taskType: "phase",
    title: "Legacy phase row",
    initialUserPrompt: "",
    updatedAtMs: 1_700_000_000_000,
    updatedLabel: "about 2 hours ago",
    updatedBucket: "today",
    linkedRepos: [],
    linkedWorkspaces: [],
    pullRequestNumbers: [],
    ownership: "mine",
    permissionRole: "owner",
    isPinned: false,
  };
}

function renderPanel() {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <EpicsListPanel
            variant="embedded"
            onSelectEpic={null}
            routeSearch={null}
            historyNowMs={null}
            autoFocusSearch={false}
          />
        </TooltipProvider>
      </QueryClientProvider>
    ),
  });
  const tabEpicRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/epics/$epicId/$tabId",
    component: () => <div data-testid="epic-tab-route" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, tabEpicRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

function seedCommittedLayout(args: {
  readonly items: ReadonlyArray<{
    readonly kind: "tab";
    readonly id: string;
    readonly ref: TabRef;
  }>;
  readonly activeItemId: string | null;
}): void {
  const layout = {
    version: 2 as const,
    items: args.items,
    activeItemId: args.activeItemId,
    systemTabs: { history: null, settings: null },
  };
  useTabsStore.setState({ ...layout, stripOrder: flattenLayoutRefs(layout) });
}

describe("<EpicsListPanel /> Phase row activation", () => {
  beforeEach(() => {
    window.localStorage.clear();
    testState.items = [phaseHistoryItem()];
    testState.refetch.mockReset();
    testState.fetchNextPage.mockReset();
    tabNavigationMocks.activateTabIntent.mockReset();
    queryClient.clear();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useHistorySearchStore.setState({ search: DEFAULT_HISTORY_SEARCH });
    __resetTabNavigationControllerForTesting();
  });

  afterEach(() => {
    cleanup();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useHistorySearchStore.setState({ search: DEFAULT_HISTORY_SEARCH });
    __resetTabNavigationControllerForTesting();
  });

  it('routes a Phase row click through activateTabIntent with an open-epic intent carrying migrationSource: "phase"', async () => {
    renderPanel();

    fireEvent.click(
      await screen.findByRole("link", { name: /open task legacy phase row/i }),
    );

    await waitFor(() => {
      expect(tabNavigationMocks.activateTabIntent).toHaveBeenCalledTimes(1);
    });
    expect(tabNavigationMocks.activateTabIntent).toHaveBeenCalledWith(
      expect.any(Function),
      openOrFocusEpicIntent({
        epicId: PHASE_EPIC_ID,
        focus: {
          focusedAt: undefined,
          focusArtifactId: undefined,
          focusThreadId: undefined,
          migrationSource: "phase",
        },
      }),
      undefined,
    );
  });

  it("restores the prior tab when a rejected Phase-row open-epic navigation is rolled back", async () => {
    // A real prior tab, open before the phase-open attempt - drives the REAL
    // controller directly (bypassing the mocked `activateTabIntent` free
    // function above) via `tabNavigationController.activate`, exactly the
    // seam the Phase row itself calls in production.
    const priorTabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-prior", "Prior");
    const priorRef: TabRef = { kind: "epic", id: priorTabId };
    seedCommittedLayout({
      items: [{ kind: "tab", id: tabItemId(priorRef), ref: priorRef }],
      activeItemId: tabItemId(priorRef),
    });

    const resolvers: Array<{
      readonly resolve: () => void;
      readonly reject: (error: Error) => void;
    }> = [];
    const asNavigate: UseNavigateResult<string> = ((
      _options: NavigateOptions,
    ) =>
      new Promise<void>((resolve, reject) => {
        resolvers.push({ resolve, reject });
      })) as UseNavigateResult<string>;

    tabNavigationController.activate(
      asNavigate,
      openOrFocusEpicIntent({
        epicId: PHASE_EPIC_ID,
        focus: {
          focusedAt: undefined,
          focusArtifactId: undefined,
          focusThreadId: undefined,
          migrationSource: "phase",
        },
      }),
      undefined,
    );

    // The freshly resolved phase-target epic is now selected - not the prior.
    expect(useTabsStore.getState().activeItemId).not.toBe(tabItemId(priorRef));

    const entry = resolvers[0];
    expect(entry, "expected a pending navigate to reject").toBeDefined();
    entry.reject(new Error("navigation cancelled"));
    await Promise.resolve();
    await Promise.resolve();

    // The rejection restores the true pre-command selection: the prior tab.
    expect(useTabsStore.getState().activeItemId).toBe(tabItemId(priorRef));
  });
});
