import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  BrowserSessionInfo,
  BrowserTabDriver,
  BrowserTabInfo,
} from "@traycer/protocol/host/browser/contracts";
import {
  fakePrepareOpenTab,
  sessionInfo,
  tabInfo,
} from "@/lib/browser-view/sessions/__tests__/browser-session-test-kit";
import { recordProvisioningReceipt } from "@/lib/browser-view/sessions/browser-open-perf";
import {
  BROWSER_TILE_DND_TYPE,
  getBrowserTileDragId,
  readEpicCanvasDragSourceData,
} from "@/components/epic-canvas/dnd/dnd";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  BrowsersPanelActions,
  BrowsersPanelBody,
} from "@/components/epic-canvas/sidebar/epic-browser-sidebar";
import type { BrowserSessionsState } from "@/components/epic-canvas/renderers/browser-sessions-context";
import {
  findOpenArtifactInTab,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import { findPaneById } from "@/stores/epics/canvas/tile-tree";
import { makeBrowserSessionTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";
import { BROWSER_TAB_AGENT_ACTIVITY_MS } from "@/lib/browser-view/browser-tab-display";
import { dismissPip } from "@/lib/browser-view/pip/pip-store";
import { BrowserCatalogContext } from "@/components/epic-canvas/renderers/browser-catalog-context";
import type { BrowserCatalogRecord } from "@traycer/protocol/host/browser/catalog-contracts";
import { useBrowserPanelStore } from "@/stores/epics/browser-panel-store";
import { usePanelHeaderSearchStore } from "@/stores/epics/panel-header-search-store";
import { usePanelHeaderMenuStore } from "@/stores/epics/panel-header-menu-store";
import {
  requestSidebarNodeReveal,
  useSidebarNodeRevealStore,
} from "@/stores/epics/sidebar-node-reveal-store";

const dndState = vi.hoisted(() => ({
  draggables: [] as Array<{
    readonly id: string | number;
    readonly data: unknown;
  }>,
}));

const browserHostPinState = vi.hoisted(() => ({
  selection: null as string | null,
  setSelection: vi.fn((selection: string | null) => {
    browserHostPinState.selection = selection;
  }),
}));

const browserHostOptionsState = vi.hoisted(() => ({
  hosts: [
    {
      hostId: "host-1",
      name: "Home Mac",
      connectable: true,
      sandbox: null,
      entry: null,
      item: null,
      health: { state: "online" },
    },
    {
      hostId: "host-2",
      name: "Work Mac",
      connectable: true,
      sandbox: null,
      entry: null,
      item: null,
      health: { state: "online" },
    },
  ],
  isLoading: false,
  listsFailed: false,
  retryLists: vi.fn(),
}));

vi.mock("@/hooks/host/use-surface-host-pin", () => ({
  useTabSurfaceKey: (kind: string, tabId: string) => `${kind}:${tabId}`,
  useSurfaceHostPin: () => ({
    selection: browserHostPinState.selection,
    honoredSelection: browserHostPinState.selection,
    setSelection: browserHostPinState.setSelection,
    resolvedHostId: browserHostPinState.selection ?? "host-1",
    followingHostId: "host-1",
    isPinned: browserHostPinState.selection !== null,
    latchOnFirstUse: () => undefined,
  }),
  useSurfaceHostClient: () => null,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostDirectoryEntryForHostId: (hostId: string | null) => ({
    label: hostId === "host-2" ? "Work Mac" : "Home Mac",
  }),
}));

vi.mock("@/components/settings/host-scope/use-host-options", () => ({
  useHostOptions: () => ({
    hosts: browserHostOptionsState.hosts,
    activeHostId: "host-1",
    isLoading: browserHostOptionsState.isLoading,
    listsResolved: true,
    listsFailed: browserHostOptionsState.listsFailed,
    retryLists: browserHostOptionsState.retryLists,
  }),
}));

vi.mock("@/hooks/host/use-reactive-local-host-id", () => ({
  useReactiveLocalHostId: () => "host-1",
}));

const catalogActions = vi.hoisted(() => ({
  closeTab: vi.fn(),
  withOwner: vi.fn(),
}));
vi.mock("@/hooks/browser/use-browser-catalog-actions", () => ({
  useBrowserCatalogActions: () => catalogActions,
}));

vi.mock("@/components/settings/host-scope/host-option-row", () => ({
  HostOptionRow: (props: { readonly host: { readonly name: string } }) => (
    <span>{props.host.name}</span>
  ),
}));

vi.mock("@/components/epic-canvas/renderers/browser-sessions-provider", () => ({
  BrowserSessionsHostProvider: (props: { readonly children: ReactNode }) =>
    props.children,
  BrowserSessionsHostBoundary: (props: { readonly children: ReactNode }) =>
    props.children,
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

vi.mock("@dnd-kit/core", () => ({
  useDraggable: (input: {
    readonly id: string | number;
    readonly data: unknown;
  }) => {
    dndState.draggables.push(input);
    return {
      attributes: {},
      listeners: {},
      setNodeRef: () => undefined,
      isDragging: false,
    };
  },
}));

const closeTab = vi.fn<(sessionId: string, tabId: string) => Promise<void>>();
const openTab = vi.fn<BrowserSessionsState["openTab"]>();
const navigateNested = vi.fn(
  (_epicId: string, _tabId: string, prepare: () => unknown) => prepare(),
);

function forwardCloseTab(sessionId: string, tabId: string): Promise<void> {
  return closeTab(sessionId, tabId);
}

function forwardOpenTab(
  sessionId: string | null,
  url: string,
): Promise<{ sessionId: string; tabId: string; handoffToken: string | null }> {
  return openTab(sessionId, url);
}

const sessionsState = vi.hoisted<{
  value: BrowserSessionsState;
}>(() => ({
  value: {
    hostId: "host-1",
    lifecycle: "live",
    inventoryReady: true,
    canMaterializeElectron: false,
    connectionGeneration: 0,
    items: [],
    viewports: {},
    setViewport: () => Promise.reject(new Error("not used")),
    reportViewport: () => undefined,
    errorMessage: null,
    retry: vi.fn(),
    openTab: forwardOpenTab,
    prepareOpenTab: () => {
      throw new Error("not used in this test");
    },
    closeTab: forwardCloseTab,
    attachTab: () => Promise.reject(new Error("not used")),
    moveTab: () => Promise.reject(new Error("not used")),
  },
}));

const chatsState = vi.hoisted(() => ({
  value: [
    { id: "chat-driver", title: "Checkout agent" },
    { id: "chat-other", title: "Other chat" },
  ],
}));

vi.mock(
  "@/components/epic-canvas/renderers/browser-sessions-context",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/epic-canvas/renderers/browser-sessions-context")
    >()),
    useBrowserSessionsContext: () => sessionsState.value,
  }),
);

vi.mock("@/lib/epic-selectors", () => ({
  useEpicChatRecords: () => chatsState.value,
}));

vi.mock("@/components/epic-canvas/hooks/use-canvas-host-id", () => ({
  useCanvasHostId: () => "host-1",
}));

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => navigateNested,
}));

function tab(
  overrides: Partial<BrowserTabInfo> & Pick<BrowserTabInfo, "tabId" | "url">,
): BrowserTabInfo {
  return tabInfo(overrides);
}

function session(
  overrides: Partial<BrowserSessionInfo> &
    Pick<BrowserSessionInfo, "sessionId" | "profile" | "tabs">,
): BrowserSessionInfo {
  return sessionInfo({
    lastActivityAt: 2,
    runtime: { kind: "electron", revision: 0 },
    ...overrides,
  });
}

// The panel's close action is a TanStack mutation. One client for the file's
// lifetime, so a re-render never strands existing observers on an old one.
const testQueryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, gcTime: 0 },
    mutations: { retry: false },
  },
});

function wrapper(node: ReactNode): ReactNode {
  return (
    <QueryClientProvider client={testQueryClient}>
      <TooltipProvider delayDuration={0}>{node}</TooltipProvider>
    </QueryClientProvider>
  );
}

function replaceSessions(items: readonly BrowserSessionInfo[]): void {
  sessionsState.value = {
    ...sessionsState.value,
    items,
  };
}

function identitySession(tabInfo: BrowserTabInfo): BrowserSessionInfo {
  return session({
    sessionId: "sess-identity",
    profile: "primary",
    tabs: [tabInfo],
  });
}

function setLiveDrivenBy(drivenBy: readonly BrowserTabDriver[]): void {
  const current = sessionsState.value.items;
  const first = current[0];
  const liveTab = first.tabs[0];
  replaceSessions([
    { ...first, tabs: [{ ...liveTab, drivenBy: [...drivenBy] }] },
    ...current.slice(1),
  ]);
}

function seedCanvasTab(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useEpicCanvasStore.setState({
    tabsById: {
      "view-tab-1": {
        tabId: "view-tab-1",
        epicId: "epic-1",
        name: "Epic 1",
      },
    },
    // A pending tab open is only counted "present" while its view tab is in
    // `openTabOrder` (see `preparePendingBrowserTile`'s observer) - a tab
    // registered only in `tabsById`, the way a real close/reopen leaves a
    // preserved-but-closed tab, reads as never opened and the pending tile
    // is dismissed the instant it is created.
    openTabOrder: ["view-tab-1"],
  });
}

describe("BrowsersPanelBody", () => {
  beforeEach(() => {
    dndState.draggables = [];
    browserHostPinState.selection = null;
    browserHostPinState.setSelection.mockClear();
    browserHostOptionsState.hosts = [
      {
        hostId: "host-1",
        name: "Home Mac",
        connectable: true,
        sandbox: null,
        entry: null,
        item: null,
        health: { state: "online" },
      },
      {
        hostId: "host-2",
        name: "Work Mac",
        connectable: true,
        sandbox: null,
        entry: null,
        item: null,
        health: { state: "online" },
      },
    ];
    browserHostOptionsState.isLoading = false;
    browserHostOptionsState.listsFailed = false;
    browserHostOptionsState.retryLists.mockClear();
    closeTab.mockReset();
    closeTab.mockResolvedValue(undefined);
    catalogActions.closeTab.mockReset();
    catalogActions.closeTab.mockResolvedValue(undefined);
    catalogActions.withOwner.mockReset();
    catalogActions.withOwner.mockImplementation(
      (hostId: string, run: (state: BrowserSessionsState) => Promise<void>) =>
        run({ ...sessionsState.value, hostId }),
    );
    openTab.mockReset();
    openTab.mockResolvedValue({
      sessionId: "sess-created",
      tabId: "tab-created",
      handoffToken: null,
    });
    vi.mocked(toast.error).mockClear();
    navigateNested.mockClear();
    usePanelHeaderSearchStore.setState(
      usePanelHeaderSearchStore.getInitialState(),
      true,
    );
    usePanelHeaderMenuStore.setState(
      usePanelHeaderMenuStore.getInitialState(),
      true,
    );
    useSidebarNodeRevealStore.setState(
      { requestsByViewTabId: {}, visibleByViewTabId: {} },
      true,
    );
    seedCanvasTab();
    sessionsState.value = {
      hostId: "host-1",
      lifecycle: "live",
      inventoryReady: true,
      canMaterializeElectron: false,
      connectionGeneration: 0,
      items: [
        session({
          sessionId: "sess-primary",
          profile: "primary",
          tabs: [
            tab({
              tabId: "tab-live",
              url: "https://app.example/live",
              title: "Live page",
              status: "ready",
              viewed: true,
              drivenBy: [
                {
                  chatId: "chat-driver",
                  agentRunId: "run-1",
                  requestId: "req-1",
                },
              ],
            }),
          ],
        }),
        session({
          sessionId: "sess-dormant",
          profile: "primary",
          tabs: [
            tab({
              tabId: "tab-dormant",
              url: "https://app.example/old",
              title: "Dormant page",
              status: "dormant",
            }),
          ],
        }),
        session({
          sessionId: "sess-iso",
          profile: "isolated",
          tabs: [
            tab({
              tabId: "tab-iso",
              url: "https://checkout.example",
              title: "Checkout",
            }),
          ],
        }),
      ],
      viewports: {},
      setViewport: () => Promise.reject(new Error("not used")),
      reportViewport: () => undefined,
      errorMessage: null,
      retry: vi.fn(),
      openTab: forwardOpenTab,
      prepareOpenTab: () => {
        throw new Error("not used in this test");
      },
      closeTab: forwardCloseTab,
      attachTab: () => Promise.reject(new Error("not used")),
      moveTab: () => Promise.reject(new Error("not used")),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    dismissPip("epic-1");
  });

  it("lists every tab as a flat peer row, with dormant styling and isolated-only badges", () => {
    render(wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />));

    expect(screen.getByText("Live page")).toBeTruthy();
    expect(screen.getByText("Dormant page")).toBeTruthy();
    expect(screen.getByText("Checkout")).toBeTruthy();
    expect(screen.queryByText("isolated")).toBeNull();
    expect(screen.queryByText("primary")).toBeNull();
    expect(screen.queryByText("Agent browser")).toBeNull();
    expect(
      screen.getByRole("button", { name: /^Dormant page, .*asleep$/ }),
    ).toBeTruthy();

    const dormantRow = screen.getByTestId(
      "epic-browser-sidebar-row-tab-dormant",
    );
    expect(dormantRow.className.split(/\s+/)).not.toContain("opacity-60");
    const liveRow = screen.getByTestId("epic-browser-sidebar-row-tab-live");
    expect(liveRow.className.split(/\s+/)).not.toContain("opacity-60");
    expect(liveRow.className.split(/\s+/)).not.toContain("font-medium");
    expect(liveRow.className.split(/\s+/)).toContain("cursor-pointer");
    expect(
      screen
        .getByRole("button", { name: /^Live page/i })
        .className.split(/\s+/),
    ).toContain("cursor-pointer");
    const isoRow = screen.getByTestId("epic-browser-sidebar-row-tab-iso");
    expect(isoRow.innerHTML).toContain("ring-warning/80");
  });

  it("scrolls to and flash-highlights a requested browser row", async () => {
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    usePanelHeaderSearchStore
      .getState()
      .openSearch("view-tab-1", "browsers", "checkout.example");
    requestSidebarNodeReveal(
      "view-tab-1",
      "browser-session:sess-primary:tab-live",
    );

    render(wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />));

    const row = screen.getByTestId("epic-browser-sidebar-row-tab-live");
    await waitFor(() => {
      expect(scrollIntoView.mock.instances).toContain(row);
    });
    expect(row.dataset.sidebarRevealHighlighted).toBe("true");
    expect(screen.getByTestId("epic-browser-sidebar-row-tab-live")).toBe(row);
    expect(
      useSidebarNodeRevealStore.getState().requestsByViewTabId["view-tab-1"],
    ).toBeUndefined();
  });

  it("keeps existing row order stable and appends newly discovered tabs", () => {
    const view = render(
      wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />),
    );
    const rowIds = (): string[] =>
      [
        ...screen
          .getByTestId("epic-browsers-panel-list")
          .querySelectorAll('[data-testid^="epic-browser-sidebar-row-"]'),
      ].map((row) => row.getAttribute("data-testid") ?? "");
    const initial = [
      "epic-browser-sidebar-row-tab-live",
      "epic-browser-sidebar-row-tab-dormant",
      "epic-browser-sidebar-row-tab-iso",
    ];

    expect(rowIds()).toEqual(initial);
    replaceSessions([...sessionsState.value.items].reverse());
    view.rerender(
      wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />),
    );
    expect(rowIds()).toEqual(initial);

    replaceSessions([
      session({
        sessionId: "sess-new",
        profile: "primary",
        tabs: [
          tab({
            tabId: "tab-new",
            url: "https://new.example",
            title: "New page",
          }),
        ],
      }),
      ...sessionsState.value.items,
    ]);
    view.rerender(
      wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />),
    );
    expect(rowIds()).toEqual([...initial, "epic-browser-sidebar-row-tab-new"]);
  });

  it("registers each row as a browser tile drag source", () => {
    render(wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />));

    const live = dndState.draggables.find((entry) =>
      String(entry.id).includes(
        getBrowserTileDragId("host-1", "sess-primary", "tab-live"),
      ),
    );
    expect(live).toBeTruthy();
    expect(readEpicCanvasDragSourceData(live?.data)).toMatchObject({
      kind: BROWSER_TILE_DND_TYPE,
      epicId: "epic-1",
      viewTabId: "view-tab-1",
      tile: {
        type: "browser-session",
        sessionId: "sess-primary",
        tabId: "tab-live",
      },
    });
  });

  it("filters the flat list by title, hostname, or URL", () => {
    usePanelHeaderSearchStore
      .getState()
      .openSearch("view-tab-1", "browsers", "checkout.example");

    render(wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />));

    expect(screen.getByText("Checkout")).toBeTruthy();
    expect(screen.queryByText("Live page")).toBeNull();
    expect(screen.queryByText("Dormant page")).toBeNull();
    expect(screen.getByText("1 browser result.")).toBeTruthy();
  });

  it("gives every row a unique, title-derived accessible close name", () => {
    render(wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />));

    expect(
      screen.getByRole("button", { name: "Close Live page" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Close Dormant page" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close Checkout" })).toBeTruthy();
  });

  it("disambiguates duplicate host fallback titles with each tab id suffix", () => {
    sessionsState.value = {
      ...sessionsState.value,
      items: [3000, 5173].map((port) =>
        session({
          sessionId: `sess-localhost-${port}`,
          profile: "primary",
          tabs: [
            tab({
              tabId: `tab-localhost-${port}`,
              url: `http://127.0.0.1:${port}`,
              viewed: true,
            }),
          ],
        }),
      ),
    };

    render(wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />));

    const closeButtons = screen.getAllByRole("button", {
      name: /^Close 127\.0\.0\.1 \(/,
    });
    expect(closeButtons).toHaveLength(2);
    const closeLabels = closeButtons.map((button) =>
      button.getAttribute("aria-label"),
    );
    expect(closeLabels).toEqual([
      "Close 127.0.0.1 (127.0.0.1 (3000))",
      "Close 127.0.0.1 (127.0.0.1 (5173))",
    ]);
    expect(screen.getByText("127.0.0.1 (3000)")).toBeTruthy();
    expect(screen.getByText("127.0.0.1 (5173)")).toBeTruthy();
    expect(screen.getAllByText("127.0.0.1")).toHaveLength(2);
  });

  it("keeps close names unique when duplicate titles and URLs collide", () => {
    const tabIds = [
      "aaaaaaaa-1111-4aaa-aaaa-aaaabbbbcccc",
      "bbbbbbbb-2222-4bbb-bbbb-bbbbddddffff",
    ];
    sessionsState.value = {
      ...sessionsState.value,
      items: tabIds.map((tabId, index) =>
        session({
          sessionId: `sess-fallback-${index}`,
          profile: "primary",
          tabs: [
            tab({
              tabId,
              url: "https://www.hotstar.com/live",
              title: "JioHotstar",
              viewed: true,
            }),
          ],
        }),
      ),
    };

    render(wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />));

    const closeLabels = screen
      .getAllByRole("button", { name: /^Close JioHotstar \(/ })
      .map((button) => button.getAttribute("aria-label"));
    expect(closeLabels).toEqual([
      "Close JioHotstar (www.hotstar.com (cccc))",
      "Close JioHotstar (www.hotstar.com (ffff))",
    ]);
  });

  it("keeps duplicate close names disambiguated while pending", async () => {
    catalogActions.closeTab.mockImplementation(
      () => new Promise<void>(() => undefined),
    );
    const tabIds = ["tab-duplicate-aaaa", "tab-duplicate-bbbb"];
    sessionsState.value = {
      ...sessionsState.value,
      items: tabIds.map((tabId, index) =>
        session({
          sessionId: `sess-duplicate-${index}`,
          profile: "primary",
          tabs: [
            tab({
              tabId,
              url: "https://www.hotstar.com/live",
              title: "JioHotstar",
              viewed: true,
            }),
          ],
        }),
      ),
    };

    render(wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />));
    for (const button of screen.getAllByRole("button", {
      name: /^Close JioHotstar/,
    })) {
      fireEvent.click(button);
    }

    // Pending state arrives with the mutation, one microtask after the click.
    await waitFor(() => {
      expect(
        screen
          .getAllByRole("button", { name: /^Closing JioHotstar/ })
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual([
        "Closing JioHotstar (www.hotstar.com (aaaa))",
        "Closing JioHotstar (www.hotstar.com (bbbb))",
      ]);
    });
  });

  it("keeps the plain close name when the active title is unique", () => {
    sessionsState.value = {
      ...sessionsState.value,
      items: [
        session({
          sessionId: "sess-unique-title",
          profile: "primary",
          tabs: [
            tab({
              tabId: "tab-unique-title",
              url: "https://unique.example",
              title: "Unique page",
              viewed: true,
            }),
          ],
        }),
      ],
    };

    render(wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />));

    expect(
      screen.getByRole("button", { name: "Close Unique page" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Close Unique page \(/ }),
    ).toBeNull();
  });

  it("keeps close controls and row names unique across near-identical sessions", () => {
    const titles = ["Checkout", "Checkout 1", "Checkout 2", "Checkout 3"];
    sessionsState.value = {
      ...sessionsState.value,
      items: titles.map((title, index) =>
        session({
          sessionId: `sess-near-${index}`,
          profile: "primary",
          tabs: [
            tab({
              tabId: `tab-near-${index}`,
              url: `https://checkout-${index}.example`,
              title,
              viewed: true,
            }),
          ],
        }),
      ),
    };

    render(wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />));

    expect(screen.getAllByRole("button", { name: /^Close / })).toHaveLength(
      titles.length,
    );
    for (const title of titles) {
      const index = titles.indexOf(title);
      expect(
        screen.getByRole("button", { name: `Close ${title}` }),
      ).toBeTruthy();
      expect(
        screen.getByRole("button", {
          name: `${title}, https://checkout-${index}.example`,
        }),
      ).toBeTruthy();
    }
  });

  it("inherits the shared sidebar scroll container", () => {
    render(wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />));

    const list = screen.getByTestId("epic-browsers-panel-list");
    const scrollContainer = list.closest('[data-sidebar="content"]');
    expect(scrollContainer).not.toBeNull();
    expect(scrollContainer?.className.split(/\s+/)).toContain("overflow-auto");
    expect(list.closest('[data-sidebar="group-content"]')).not.toBeNull();
  });

  it("skips empty sessions and handles malformed URLs with mixed tab status", () => {
    sessionsState.value = {
      ...sessionsState.value,
      items: [
        session({
          sessionId: "sess-empty-tabs",
          profile: "primary",
          tabs: [],
        }),
        session({
          sessionId: "sess-invalid-url",
          profile: "primary",
          tabs: [
            tab({
              tabId: "tab-invalid-url",
              url: "not a URL",
              title: "   ",
              viewed: true,
              status: "ready",
            }),
            tab({
              tabId: "tab-dormant-subrow",
              url: "https://old.example/path",
              title: "Old page",
              status: "dormant",
            }),
          ],
        }),
      ],
    };

    render(wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />));

    expect(screen.getByText("Browser")).toBeTruthy();
    expect(screen.queryByText("Agent browser")).toBeNull();
    expect(screen.queryByText("not a URL")).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Close / })).toHaveLength(2);
    expect(screen.getByText("Old page")).toBeTruthy();
    expect(
      screen.getByTestId("epic-browser-sidebar-row-tab-dormant-subrow")
        .className,
    ).not.toContain("opacity-60");
    expect(
      screen.getByTestId("epic-browser-sidebar-row-tab-invalid-url").className,
    ).not.toContain("opacity-60");
  });

  it("shows a retryable error state instead of an empty list when the catalog cannot load", () => {
    const refetch = vi.fn();
    render(
      wrapper(
        <BrowserCatalogContext.Provider
          value={{ status: "error", scope: "cloud", records: [], refetch }}
        >
          <BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />
        </BrowserCatalogContext.Provider>,
      ),
    );

    expect(screen.getByText("Couldn't load browser tabs.")).toBeTruthy();
    expect(screen.queryByText("No browsers yet.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("shows drivenBy attribution via real tooltip and opens the driving chat", async () => {
    vi.useFakeTimers();
    const drivingSession = sessionsState.value.items[0];
    sessionsState.value = {
      ...sessionsState.value,
      items: [
        { ...drivingSession, hostId: "host-2" },
        ...sessionsState.value.items.slice(1),
      ],
    };
    render(wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />));
    expect(
      screen.queryByRole("button", { name: /Open driving chat/ }),
    ).toBeNull();

    act(() => {
      vi.advanceTimersByTime(400);
    });
    vi.useRealTimers();

    const user = userEvent.setup();
    const driveButton = screen.getByRole("button", {
      name: "Open driving chat: Checkout agent",
    });
    await user.hover(driveButton);

    await waitFor(() => {
      expect(screen.getByText("Driven by Checkout agent")).toBeTruthy();
    });

    fireEvent.click(driveButton);
    expect(navigateNested).toHaveBeenCalledWith(
      "epic-1",
      "view-tab-1",
      expect.any(Function),
    );
    const opened = findOpenArtifactInTab("view-tab-1", "chat-driver");
    expect(opened).not.toBeNull();
    if (opened === null) throw new Error("expected driving chat tile");
    expect(
      useEpicCanvasStore.getState().canvasByTabId["view-tab-1"]
        ?.tilesByInstanceId[opened.instanceId],
    ).toMatchObject({ hostId: "host-2" });
  });

  it("closes the named tab and its pointer tile only after closeTab succeeds", async () => {
    render(wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />));

    fireEvent.click(screen.getByRole("button", { name: /^Live page/i }));
    const pointer = makeBrowserSessionTileRef({
      hostId: "host-1",
      sessionId: "sess-primary",
      tabId: "tab-live",
    });
    expect(findOpenArtifactInTab("view-tab-1", pointer.id)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close Live page" }));
    // The close runs as a mutation, so the host frame goes out on the next
    // microtask rather than inside the click.
    await waitFor(() => {
      expect(catalogActions.closeTab).toHaveBeenCalledWith(
        { epicId: "epic-1", hostId: "host-1", sessionId: "sess-primary" },
        "tab-live",
      );
    });
    await waitFor(() => {
      expect(findOpenArtifactInTab("view-tab-1", pointer.id)).toBeNull();
    });
  });

  it("row click previews a browser tab and double click makes it durable", () => {
    render(wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />));

    const row = screen.getByRole("button", { name: /^Live page/i });
    fireEvent.click(row);

    const expected = makeBrowserSessionTileRef({
      hostId: "host-1",
      sessionId: "sess-primary",
      tabId: "tab-live",
    });
    const open = findOpenArtifactInTab("view-tab-1", expected.id);
    expect(open).not.toBeNull();
    if (open === null) throw new Error("expected open browser pointer");
    const tile =
      useEpicCanvasStore.getState().canvasByTabId["view-tab-1"]
        ?.tilesByInstanceId[open.instanceId];
    expect(tile).toMatchObject({
      type: "browser-session",
      sessionId: "sess-primary",
      tabId: "tab-live",
      id: expected.id,
    });
    const previewCanvas =
      useEpicCanvasStore.getState().canvasByTabId["view-tab-1"];
    expect(
      findPaneById(previewCanvas?.root ?? null, open.paneId)?.previewTabId,
    ).toBe(open.instanceId);

    fireEvent.doubleClick(row);

    const durableCanvas =
      useEpicCanvasStore.getState().canvasByTabId["view-tab-1"];
    expect(
      findPaneById(durableCanvas?.root ?? null, open.paneId)?.previewTabId,
    ).toBeNull();
    expect(findOpenArtifactInTab("view-tab-1", expected.id)?.instanceId).toBe(
      open.instanceId,
    );
  });

  it("Shift+Enter makes a browser preview durable", async () => {
    const user = userEvent.setup();
    render(wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />));

    const row = screen.getByRole("button", { name: /^Live page/i });
    expect(row.getAttribute("aria-keyshortcuts")).toBe("Shift+Enter");
    await user.click(row);

    const expected = makeBrowserSessionTileRef({
      hostId: "host-1",
      sessionId: "sess-primary",
      tabId: "tab-live",
    });
    const open = findOpenArtifactInTab("view-tab-1", expected.id);
    expect(open).not.toBeNull();
    if (open === null) throw new Error("expected open browser pointer");

    await user.keyboard("{Shift>}{Enter}{/Shift}");

    const canvas = useEpicCanvasStore.getState().canvasByTabId["view-tab-1"];
    expect(
      findPaneById(canvas?.root ?? null, open.paneId)?.previewTabId,
    ).toBeNull();
  });

  it("row click focuses an existing pointer tile instead of opening a duplicate", () => {
    const existing = makeBrowserSessionTileRef({
      hostId: "host-1",
      sessionId: "sess-primary",
      tabId: "tab-live",
    });
    useEpicCanvasStore.getState().openTileInTab("view-tab-1", existing);
    const beforeCount = Object.keys(
      useEpicCanvasStore.getState().canvasByTabId["view-tab-1"]
        ?.tilesByInstanceId ?? {},
    ).length;

    render(wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />));
    fireEvent.click(screen.getByRole("button", { name: /^Live page/i }));

    const afterCount = Object.keys(
      useEpicCanvasStore.getState().canvasByTabId["view-tab-1"]
        ?.tilesByInstanceId ?? {},
    ).length;
    expect(afterCount).toBe(beforeCount);
    const focused = findOpenArtifactInTab("view-tab-1", existing.id);
    expect(typeof focused?.paneId).toBe("string");
    expect(focused?.instanceId).toBe(existing.instanceId);
  });

  it("shows the empty state with an Add browser action when there are no sessions", () => {
    sessionsState.value = { ...sessionsState.value, items: [] };
    render(wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />));

    expect(screen.getByTestId("browser-list-empty-state")).toBeTruthy();
    expect(screen.getByText("No browsers yet.")).toBeTruthy();
    expect(screen.getByTestId("browser-empty-add")).toBeTruthy();
  });

  // B3: closing the last tab leaves the session dormant on the host. The panel
  // lists tabs, not sessions, so a dormant one contributes no row and no header
  // - and a surface holding only dormant sessions reads as empty.
  it("renders nothing for a session with no tabs", () => {
    replaceSessions([
      session({ sessionId: "sess-dormant", profile: "primary", tabs: [] }),
      session({
        sessionId: "sess-live",
        profile: "primary",
        tabs: [tab({ tabId: "tab-live", url: "https://example.com" })],
      }),
    ]);
    render(wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />));

    expect(
      screen.getByTestId("epic-browsers-panel-list").children,
    ).toHaveLength(1);
    expect(
      screen.getByTestId("epic-browser-sidebar-row-tab-live"),
    ).toBeTruthy();
    expect(screen.queryByText(/sess-dormant/)).toBeNull();

    cleanup();
    replaceSessions([
      session({ sessionId: "sess-dormant", profile: "primary", tabs: [] }),
    ]);
    render(wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />));

    expect(
      screen.getByTestId("epic-browsers-panel-list").children,
    ).toHaveLength(0);
    expect(screen.getByTestId("browser-list-empty-state")).toBeTruthy();
  });

  it("holds settled row identity through navigating and provisioning, and never regresses a document title", () => {
    replaceSessions([
      identitySession(
        tab({
          tabId: "tab-identity",
          url: "https://thecapitalgrille.com",
          title: "The Capital Grille",
          status: "ready",
        }),
      ),
    ]);
    const view = render(
      wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />),
    );
    const row = (): HTMLElement =>
      screen.getByTestId("epic-browser-sidebar-row-tab-identity");

    expect(screen.getByText("The Capital Grille")).toBeTruthy();
    expect(screen.getByText("thecapitalgrille.com")).toBeTruthy();
    const settledFavicon = row().querySelector("img");
    expect(settledFavicon?.getAttribute("src")).toBe(
      "https://thecapitalgrille.com/favicon.ico",
    );
    expect(row().querySelector(".lucide-earth")).not.toBeNull();
    if (settledFavicon !== null) fireEvent.load(settledFavicon);
    expect(row().querySelector(".lucide-earth")).toBeNull();
    if (settledFavicon !== null) fireEvent.error(settledFavicon);
    expect(row().querySelector(".lucide-earth")).not.toBeNull();
    if (settledFavicon !== null) fireEvent.load(settledFavicon);

    replaceSessions([
      identitySession(
        tab({
          tabId: "tab-identity",
          url: "https://thecapitalgrille.com/menu",
          title: "thecapitalgrille.com",
          status: "navigating",
        }),
      ),
    ]);
    view.rerender(
      wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />),
    );
    expect(screen.getByText("The Capital Grille")).toBeTruthy();
    expect(screen.getByText("thecapitalgrille.com")).toBeTruthy();
    expect(row().querySelector("img")?.getAttribute("src")).toBe(
      "https://thecapitalgrille.com/favicon.ico",
    );

    replaceSessions([
      identitySession(
        tab({
          tabId: "tab-identity",
          url: "https://thecapitalgrille.com/reservations",
          title: "Loading",
          status: "provisioning",
        }),
      ),
    ]);
    view.rerender(
      wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />),
    );
    expect(screen.getByText("The Capital Grille")).toBeTruthy();
    expect(screen.queryByText("Loading")).toBeNull();

    replaceSessions([
      identitySession(
        tab({
          tabId: "tab-identity",
          url: "https://thepier5.com",
          title: "Waterfront",
          status: "navigating",
        }),
      ),
    ]);
    view.rerender(
      wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />),
    );
    expect(screen.getByText("The Capital Grille")).toBeTruthy();
    expect(screen.queryByText("Waterfront")).toBeNull();
    expect(row().querySelector("img")).toBeNull();
    expect(row().querySelector(".lucide-earth")).not.toBeNull();
    expect(
      screen.getByRole("button", {
        name: "The Capital Grille, https://thecapitalgrille.com",
      }),
    ).toBeTruthy();

    replaceSessions([
      identitySession(
        tab({
          tabId: "tab-identity",
          url: "https://thepier5.com",
          title: "The Capital Grille",
          status: "ready",
        }),
      ),
    ]);
    view.rerender(
      wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />),
    );
    expect(screen.getByText("The Capital Grille")).toBeTruthy();
    expect(screen.getByText("thepier5.com")).toBeTruthy();
    expect(screen.queryByText("thecapitalgrille.com")).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "The Capital Grille, https://thepier5.com",
      }),
    ).toBeTruthy();
    expect(row().querySelector("img")?.getAttribute("src")).toBe(
      "https://thepier5.com/favicon.ico",
    );
  });

  it("matches search against settled identity, not a live redirect URL", () => {
    replaceSessions([
      identitySession(
        tab({
          tabId: "tab-identity",
          url: "https://thecapitalgrille.com",
          title: "The Capital Grille",
          status: "ready",
        }),
      ),
    ]);
    const view = render(
      wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />),
    );
    usePanelHeaderSearchStore
      .getState()
      .openSearch("view-tab-1", "browsers", "thepier5.com");
    view.rerender(
      wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />),
    );
    expect(screen.queryByText("The Capital Grille")).toBeNull();

    usePanelHeaderSearchStore
      .getState()
      .openSearch("view-tab-1", "browsers", "thecapitalgrille.com");
    replaceSessions([
      identitySession(
        tab({
          tabId: "tab-identity",
          url: "https://thepier5.com",
          title: "Waterfront",
          status: "navigating",
        }),
      ),
    ]);
    view.rerender(
      wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />),
    );
    expect(screen.getByText("The Capital Grille")).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "The Capital Grille, https://thecapitalgrille.com",
      }),
    ).toBeTruthy();
  });

  it("shows generic Browser and the Globe placeholder until a new tab settles", () => {
    replaceSessions([
      identitySession(
        tab({
          tabId: "tab-new",
          url: "https://www.thecapitalgrille.com",
          title: "thecapitalgrille.com",
          status: "navigating",
        }),
      ),
    ]);
    render(wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />));

    const row = screen.getByTestId("epic-browser-sidebar-row-tab-new");
    expect(screen.getByText("Browser")).toBeTruthy();
    expect(screen.queryByText("thecapitalgrille.com")).toBeNull();
    expect(row.querySelector("img")).toBeNull();
    expect(row.querySelector(".lucide-earth")).not.toBeNull();
  });

  it("keeps close in its own slot with a spinner, leaves canvas tiles open, and restores close after a failed ack", async () => {
    let rejectClose: ((error: Error) => void) | undefined;
    catalogActions.closeTab.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectClose = reject;
        }),
    );
    vi.useFakeTimers();
    render(wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />));
    fireEvent.click(screen.getByRole("button", { name: /^Live page/i }));
    const expected = makeBrowserSessionTileRef({
      hostId: "host-1",
      sessionId: "sess-primary",
      tabId: "tab-live",
    });
    expect(findOpenArtifactInTab("view-tab-1", expected.id)).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(BROWSER_TAB_AGENT_ACTIVITY_MS);
    });
    expect(
      screen
        .getByTestId("epic-browser-sidebar-row-tab-live")
        .querySelector(".lucide-bot"),
    ).not.toBeNull();

    // Real timers before the close: the mutation that drives the pending state
    // settles on the microtask queue, and `waitFor` needs a real clock to
    // observe it.
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: "Close Live page" }));
    // The pending state arrives with the mutation, one microtask after the
    // click, so the row is re-read once it has settled into closing.
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Closing Live page" }),
      ).toBeTruthy();
    });
    const row = screen.getByTestId("epic-browser-sidebar-row-tab-live");
    expect(row.querySelector(".lucide-bot")).toBeNull();
    const pendingClose = screen.getByTestId(
      "epic-browser-sidebar-close-tab-live",
    );
    // The close control keeps its own grid slot (never collapses into the
    // title) and its fixed control size while the close is in flight.
    expect(pendingClose.className).toContain("size-6");
    expect(pendingClose.className).toContain("justify-self-center");
    expect(pendingClose.getAttribute("aria-label")).toBe("Closing Live page");
    expect(pendingClose.querySelector(".font-mono")).not.toBeNull();
    expect(pendingClose.querySelector(".lucide-x")).toBeNull();
    expect(findOpenArtifactInTab("view-tab-1", expected.id)).not.toBeNull();
    if (rejectClose === undefined) {
      throw new Error("expected pending close rejection");
    }
    const rejectPendingClose = rejectClose;

    act(() => {
      rejectPendingClose(new Error("Browser sessions stream closed."));
    });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't close Live page. Try again.",
        { duration: Infinity },
      );
    });
    const restoredClose = screen.getByRole("button", {
      name: "Close Live page",
    });
    expect(restoredClose.querySelector(".lucide-x")).not.toBeNull();
    expect(findOpenArtifactInTab("view-tab-1", expected.id)).not.toBeNull();
  });

  it("ignores agent activity shorter than 400ms", () => {
    vi.useFakeTimers();
    const view = render(
      wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />),
    );
    expect(
      screen.queryByRole("button", { name: /Open driving chat/ }),
    ).toBeNull();

    act(() => {
      vi.advanceTimersByTime(BROWSER_TAB_AGENT_ACTIVITY_MS - 1);
    });
    expect(
      screen.queryByRole("button", { name: /Open driving chat/ }),
    ).toBeNull();

    setLiveDrivenBy([]);
    view.rerender(
      wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />),
    );
    act(() => {
      vi.advanceTimersByTime(BROWSER_TAB_AGENT_ACTIVITY_MS);
    });
    expect(
      screen.queryByRole("button", { name: /Open driving chat/ }),
    ).toBeNull();
  });

  it("holds one generic bot glyph across adjacent same-chat bursts without in-flow chat titles", () => {
    vi.useFakeTimers();
    const view = render(
      wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />),
    );
    act(() => {
      vi.advanceTimersByTime(BROWSER_TAB_AGENT_ACTIVITY_MS);
    });
    const liveRow = screen.getByTestId("epic-browser-sidebar-row-tab-live");
    expect(
      screen.getByRole("button", { name: "Open driving chat: Checkout agent" }),
    ).toBeTruthy();
    expect(screen.queryByText("Checkout agent")).toBeNull();
    expect(liveRow.querySelectorAll(".lucide-bot")).toHaveLength(1);

    setLiveDrivenBy([]);
    view.rerender(
      wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />),
    );
    expect(
      screen.getByRole("button", { name: "Open driving chat: Checkout agent" }),
    ).toBeTruthy();

    setLiveDrivenBy([
      { chatId: "chat-driver", agentRunId: "run-2", requestId: "req-2" },
    ]);
    view.rerender(
      wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />),
    );
    act(() => {
      vi.advanceTimersByTime(BROWSER_TAB_AGENT_ACTIVITY_MS - 1);
    });
    expect(
      screen.getByRole("button", { name: "Open driving chat: Checkout agent" }),
    ).toBeTruthy();
    expect(
      screen
        .getByTestId("epic-browser-sidebar-row-tab-live")
        .querySelectorAll(".lucide-bot"),
    ).toHaveLength(1);
    expect(screen.queryByText("Checkout agent")).toBeNull();

    setLiveDrivenBy([]);
    view.rerender(
      wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />),
    );
    act(() => {
      vi.advanceTimersByTime(BROWSER_TAB_AGENT_ACTIVITY_MS);
    });
    expect(
      screen.queryByRole("button", { name: /Open driving chat/ }),
    ).toBeNull();
  });

  it("does not let a different chat inherit the visible activity grace", () => {
    vi.useFakeTimers();
    const view = render(
      wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />),
    );
    act(() => {
      vi.advanceTimersByTime(BROWSER_TAB_AGENT_ACTIVITY_MS);
    });
    expect(
      screen.getByRole("button", { name: "Open driving chat: Checkout agent" }),
    ).toBeTruthy();

    setLiveDrivenBy([
      { chatId: "chat-other", agentRunId: "run-2", requestId: "req-other" },
    ]);
    view.rerender(
      wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />),
    );
    expect(
      screen.queryByRole("button", {
        name: "Open driving chat: Checkout agent",
      }),
    ).toBeNull();
    act(() => {
      vi.advanceTimersByTime(BROWSER_TAB_AGENT_ACTIVITY_MS - 1);
    });
    expect(
      screen.queryByRole("button", { name: "Open driving chat: Other chat" }),
    ).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(
      screen.getByRole("button", { name: "Open driving chat: Other chat" }),
    ).toBeTruthy();
  });

  it("keeps failed rows neutrally identifiable with an alert and visible close", () => {
    replaceSessions([
      session({
        sessionId: "sess-failed",
        profile: "primary",
        tabs: [
          tab({
            tabId: "tab-failed",
            url: "https://www.hotstar.com/live",
            title: "JioHotstar",
            status: "crashed",
          }),
        ],
      }),
    ]);
    render(wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />));

    const row = screen.getByTestId("epic-browser-sidebar-row-tab-failed");
    expect(screen.getByText("JioHotstar")).toBeTruthy();
    expect(row.className.split(/\s+/)).not.toContain("opacity-60");
    expect(row.querySelector(".lucide-triangle-alert")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: /^JioHotstar, .*failed$/ }),
    ).toBeTruthy();
    expect(screen.queryByText("failed")).toBeNull();
    const closeButton = screen.getByRole("button", {
      name: "Close JioHotstar",
    });
    expect(closeButton.className.split(/\s+/)).toContain("opacity-100");
  });

  it("logs the receipt-to-row perf span through the row's own RAF effect, not before it flushes", async () => {
    recordProvisioningReceipt(
      session({
        sessionId: "sess-provisioning",
        profile: "primary",
        tabs: [],
      }),
    );
    const previousTelemetry = window.localStorage.getItem(
      "traycer:perf:telemetry",
    );
    window.localStorage.setItem("traycer:perf:telemetry", "1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    onTestFinished(() => {
      warn.mockRestore();
      if (previousTelemetry === null) {
        window.localStorage.removeItem("traycer:perf:telemetry");
      } else {
        window.localStorage.setItem(
          "traycer:perf:telemetry",
          previousTelemetry,
        );
      }
    });

    replaceSessions([
      session({
        sessionId: "sess-provisioning",
        profile: "primary",
        tabs: [
          tab({
            tabId: "tab-provisioning",
            url: "https://provisioning.example",
            title: "Provisioning page",
            status: "provisioning",
          }),
        ],
      }),
    ]);
    render(wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />));

    // `BrowserTabRow` schedules the measurement in a `useLayoutEffect` via
    // `requestAnimationFrame` - it must not have fired synchronously with the
    // render itself, only once that frame actually flushes.
    expect(warn).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(warn).toHaveBeenCalledTimes(1);
    });
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line.startsWith("[traycer-perf] ")).toBe(true);
    const payload = JSON.parse(line.slice("[traycer-perf] ".length)) as {
      readonly name: string;
      readonly fields: { readonly hostId: string; readonly sessionId: string };
    };
    expect(payload.name).toBe("receipt-to-row");
    expect(payload.fields.hostId).toBe("host-1");
    expect(payload.fields.sessionId).toBe("sess-provisioning");
  });
});

describe("BrowsersPanelActions", () => {
  beforeEach(() => {
    navigateNested.mockClear();
    openTab.mockReset();
    openTab.mockResolvedValue({
      sessionId: "sess-created",
      tabId: "tab-created",
      handoffToken: null,
    });
    browserHostPinState.selection = null;
    browserHostPinState.setSelection.mockClear();
    catalogActions.withOwner.mockReset();
    useBrowserPanelStore.setState({ preferences: {} });
    browserHostOptionsState.hosts = [
      {
        hostId: "host-1",
        name: "Home Mac",
        connectable: true,
        sandbox: null,
        entry: null,
        item: null,
        health: { state: "online" },
      },
      {
        hostId: "host-2",
        name: "Work Mac",
        connectable: true,
        sandbox: null,
        entry: null,
        item: null,
        health: { state: "online" },
      },
    ];
    browserHostOptionsState.isLoading = false;
    browserHostOptionsState.listsFailed = false;
    browserHostOptionsState.retryLists.mockClear();
    seedCanvasTab();
    usePanelHeaderSearchStore.setState(
      usePanelHeaderSearchStore.getInitialState(),
      true,
    );
    usePanelHeaderMenuStore.setState(
      usePanelHeaderMenuStore.getInitialState(),
      true,
    );
    sessionsState.value = {
      hostId: "host-1",
      lifecycle: "live",
      inventoryReady: true,
      canMaterializeElectron: false,
      connectionGeneration: 0,
      items: [],
      viewports: {},
      setViewport: () => Promise.reject(new Error("not used")),
      reportViewport: () => undefined,
      errorMessage: null,
      retry: vi.fn(),
      openTab: forwardOpenTab,
      prepareOpenTab: fakePrepareOpenTab({
        hostId: () => sessionsState.value.hostId ?? "host-1",
        openTab: forwardOpenTab,
      }),
      closeTab: forwardCloseTab,
      attachTab: () => Promise.reject(new Error("not used")),
      moveTab: () => Promise.reject(new Error("not used")),
    };
  });

  afterEach(() => {
    cleanup();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("creates the browser on the device chosen in the picker and places its pointer there", async () => {
    const user = userEvent.setup();
    catalogActions.withOwner.mockImplementation(
      (hostId: string, run: (state: BrowserSessionsState) => Promise<void>) =>
        run({ ...sessionsState.value, hostId }),
    );
    render(
      wrapper(<BrowsersPanelActions epicId="epic-1" tabId="view-tab-1" />),
    );

    await user.click(screen.getByRole("button", { name: "Add browser" }));
    await user.click(screen.getByRole("menuitem", { name: /Work Mac/ }));

    await waitFor(() => {
      expect(catalogActions.withOwner).toHaveBeenCalledWith(
        "host-2",
        expect.any(Function),
      );
    });
    await waitFor(() => {
      expect(navigateNested).toHaveBeenCalledWith(
        "epic-1",
        "view-tab-1",
        expect.any(Function),
      );
    });
    expect(browserHostPinState.setSelection).not.toHaveBeenCalled();
  });

  it("suggests the task's device first in the picker", async () => {
    const user = userEvent.setup();
    render(
      wrapper(<BrowsersPanelActions epicId="epic-1" tabId="view-tab-1" />),
    );

    await user.click(screen.getByRole("button", { name: "Add browser" }));

    const first = screen.getAllByRole("menuitem")[0];
    expect(first.textContent).toContain("Home Mac");
    expect(first.textContent).toContain("Suggested");
  });

  it("opens browser search from the header action", () => {
    render(
      wrapper(<BrowsersPanelActions epicId="epic-1" tabId="view-tab-1" />),
    );

    fireEvent.click(screen.getByRole("button", { name: "Search browsers" }));

    expect(
      usePanelHeaderSearchStore.getState().openBySurfaceKey[
        JSON.stringify(["view-tab-1", "browsers"])
      ],
    ).toBe(true);
  });

  it("turns on offline devices from the filter and shows the active badge", async () => {
    const user = userEvent.setup();
    render(
      wrapper(<BrowsersPanelActions epicId="epic-1" tabId="view-tab-1" />),
    );

    await user.click(screen.getByRole("button", { name: "Filter browsers" }));
    const filterMenu = screen.getByTestId("epic-browsers-panel-filter-menu");
    expect(filterMenu.getAttribute("data-side")).toBe("right");
    await user.click(
      screen.getByRole("menuitemcheckbox", { name: "Show offline devices" }),
    );

    expect(
      useBrowserPanelStore.getState().preferences[
        JSON.stringify([null, "epic-1"])
      ]?.showOffline,
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Filter browsers, 1 filter active" }),
    ).toBeTruthy();
  });

  it("keeps the simulator device choice separate from browser discovery", async () => {
    const user = userEvent.setup();
    render(
      wrapper(<BrowsersPanelActions epicId="epic-1" tabId="view-tab-1" />),
    );

    await user.click(screen.getByRole("button", { name: "Filter browsers" }));
    await user.click(screen.getByRole("menuitem", { name: "Open links on" }));
    expect(
      screen
        .getByTestId("epic-browsers-panel-filter-menu")
        .getAttribute("data-side"),
    ).toBe("right");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Work Mac" }));

    expect(browserHostPinState.setSelection).toHaveBeenCalledWith("host-2");
    expect(catalogActions.withOwner).not.toHaveBeenCalled();
  });

  it("clears a pinned simulator device back to the task device", async () => {
    const user = userEvent.setup();
    browserHostPinState.selection = "host-2";
    render(
      wrapper(<BrowsersPanelActions epicId="epic-1" tabId="view-tab-1" />),
    );

    await user.click(screen.getByRole("button", { name: "Filter browsers" }));
    await user.click(screen.getByRole("menuitem", { name: "Open links on" }));
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: /Follow task device/ }),
    );

    expect(browserHostPinState.setSelection).toHaveBeenCalledWith(null);
  });

  it("loads simulator device choices progressively", async () => {
    const user = userEvent.setup();
    browserHostOptionsState.hosts = [];
    browserHostOptionsState.isLoading = true;
    render(
      wrapper(<BrowsersPanelActions epicId="epic-1" tabId="view-tab-1" />),
    );

    await user.click(screen.getByRole("button", { name: "Filter browsers" }));
    await user.click(screen.getByRole("menuitem", { name: "Open links on" }));

    expect(screen.getByText("Loading hosts…")).toBeTruthy();
  });
});

describe("grouped catalog list", () => {
  function catalogRecord(
    hostId: string,
    sessionId: string,
    tabs: ReadonlyArray<{ tabId: string; title: string; url: string }>,
  ): BrowserCatalogRecord {
    return {
      epicId: "epic-1",
      hostId,
      sessionId,
      inventoryRevision: 1,
      lastActivityAt: 1,
      tabs: [...tabs],
    };
  }

  function catalogPanel(): ReactNode {
    const records = [
      catalogRecord("host-1", "s1", [
        { tabId: "t1", title: "Docs", url: "https://docs.example" },
      ]),
      catalogRecord("host-2", "s2", [
        { tabId: "t2", title: "Docs", url: "https://work.example/docs" },
        { tabId: "t3", title: "Billing", url: "https://billing.example" },
      ]),
      catalogRecord("host-3", "s3", [
        { tabId: "t4", title: "Router", url: "http://192.168.0.1" },
      ]),
    ];
    return wrapper(
      <BrowserCatalogContext.Provider
        value={{ status: "ready", scope: "cloud", records, refetch: vi.fn() }}
      >
        <BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />
      </BrowserCatalogContext.Provider>,
    );
  }

  beforeEach(() => {
    window.localStorage.clear();
    useBrowserPanelStore.setState({ preferences: {} });
    browserHostPinState.selection = null;
    browserHostOptionsState.isLoading = false;
    browserHostOptionsState.hosts = [
      {
        hostId: "host-1",
        name: "Home Mac",
        connectable: true,
        sandbox: null,
        entry: null,
        item: null,
        health: { state: "online" },
      },
      {
        hostId: "host-2",
        name: "Work Mac",
        connectable: true,
        sandbox: null,
        entry: null,
        item: null,
        health: { state: "online" },
      },
      {
        hostId: "host-3",
        name: "NAS",
        connectable: true,
        sandbox: null,
        entry: null,
        item: null,
        health: { state: "offline" },
      },
    ];
    catalogActions.closeTab.mockReset();
    catalogActions.closeTab.mockResolvedValue(undefined);
    usePanelHeaderSearchStore.setState(
      usePanelHeaderSearchStore.getInitialState(),
      true,
    );
    usePanelHeaderMenuStore.setState(
      usePanelHeaderMenuStore.getInitialState(),
      true,
    );
    seedCanvasTab();
    sessionsState.value = {
      ...sessionsState.value,
      lifecycle: "connecting",
      inventoryReady: false,
      items: [],
    };
  });

  afterEach(() => {
    cleanup();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("groups tabs under their device, labels the local one, counts tabs and hides the offline device", () => {
    render(catalogPanel());

    const home = screen.getByTestId("browser-device-group-host-1");
    const work = screen.getByTestId("browser-device-group-host-2");
    expect(home.textContent).toContain("Home Mac");
    expect(home.textContent).toContain("Local");
    expect(work.textContent).toContain("Work Mac");
    expect(work.textContent).not.toContain("Local");
    expect(screen.getByLabelText("2 tabs")).toBeTruthy();
    expect(screen.queryByTestId("browser-device-group-host-3")).toBeNull();
    expect(screen.getAllByText("Docs")).toHaveLength(2);
  });

  it("remembers a collapsed device across remounts", async () => {
    const user = userEvent.setup();
    const first = render(catalogPanel());
    await user.click(screen.getByRole("button", { name: /Work Mac/ }));
    expect(
      screen
        .getByRole("button", { name: /Work Mac/ })
        .getAttribute("aria-expanded"),
    ).toBe("false");

    first.unmount();
    render(catalogPanel());

    expect(
      screen
        .getByRole("button", { name: /Work Mac/ })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      screen
        .getByRole("button", { name: /Home Mac/ })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("expands a collapsed device for a matching search and restores the collapse when cleared", async () => {
    const user = userEvent.setup();
    render(catalogPanel());
    await user.click(screen.getByRole("button", { name: /Work Mac/ }));
    const work = (): HTMLElement =>
      screen.getByRole("button", { name: /Work Mac/ });
    expect(work().getAttribute("aria-expanded")).toBe("false");

    act(() =>
      usePanelHeaderSearchStore
        .getState()
        .openSearch("view-tab-1", "browsers", "billing"),
    );
    expect(work().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Billing")).toBeTruthy();

    act(() =>
      usePanelHeaderSearchStore
        .getState()
        .setSearchQuery("view-tab-1", "browsers", ""),
    );
    expect(work().getAttribute("aria-expanded")).toBe("false");
  });

  it("offers Include offline devices for a search that only an offline device matches, keeping the query", async () => {
    const user = userEvent.setup();
    render(catalogPanel());
    act(() =>
      usePanelHeaderSearchStore
        .getState()
        .openSearch("view-tab-1", "browsers", "router"),
    );

    expect(screen.getByText("No matching browsers.")).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Include offline devices" }),
    );

    expect(
      screen.getByTestId("browser-device-group-host-3").textContent,
    ).toContain("Offline");
    expect(screen.getByText("Router")).toBeTruthy();
    expect(
      usePanelHeaderSearchStore.getState().queryBySurfaceKey[
        JSON.stringify(["view-tab-1", "browsers"])
      ],
    ).toBe("router");
  });

  it("closes a catalog tab through its owning device, not the task host's live list", async () => {
    render(catalogPanel());

    fireEvent.click(screen.getAllByRole("button", { name: /^Close Docs/ })[1]);

    await waitFor(() => {
      expect(catalogActions.closeTab).toHaveBeenCalledWith(
        { epicId: "epic-1", hostId: "host-2", sessionId: "s2" },
        "t2",
      );
    });
    expect(closeTab).not.toHaveBeenCalled();
  });
});
