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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { toast } from "sonner";
import type {
  BrowserSessionInfo,
  BrowserTabDriver,
  BrowserTabInfo,
} from "@traycer/protocol/host/browser/contracts";
import {
  BROWSER_TILE_DND_TYPE,
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
import { makeBrowserSessionTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";
import { BROWSER_TAB_AGENT_ACTIVITY_MS } from "@/lib/browser-view/browser-tab-display";
import { dismissPip } from "@/lib/browser-view/pip/pip-store";
import { usePanelHeaderSearchStore } from "@/stores/epics/panel-header-search-store";
import { usePanelHeaderMenuStore } from "@/stores/epics/panel-header-menu-store";

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

const browserHostProviderState = vi.hoisted(() => ({
  hostIds: [] as Array<string | null>,
}));

const browserHostOptionsState = vi.hoisted(() => ({
  hosts: [
    { hostId: "host-1", name: "Home Mac", connectable: true },
    { hostId: "host-2", name: "Work Mac", connectable: true },
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
    listsFailed: browserHostOptionsState.listsFailed,
    retryLists: browserHostOptionsState.retryLists,
  }),
}));

vi.mock("@/components/settings/host-scope/host-option-row", () => ({
  HostOptionRow: (props: { readonly host: { readonly name: string } }) => (
    <span>{props.host.name}</span>
  ),
}));

vi.mock("@/components/epic-canvas/renderers/browser-sessions-provider", () => ({
  BrowserSessionsHostProvider: (props: {
    readonly hostId: string | null;
    readonly children: ReactNode;
  }) => {
    browserHostProviderState.hostIds.push(props.hostId);
    return props.children;
  },
  BrowserSessionsHostBoundary: (props: {
    readonly hostId: string | null;
    readonly children: ReactNode;
  }) => {
    browserHostProviderState.hostIds.push(props.hostId);
    return props.children;
  },
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
): Promise<{ sessionId: string; tabId: string }> {
  return openTab(sessionId, url);
}

const sessionsState = vi.hoisted<{
  value: BrowserSessionsState;
}>(() => ({
  value: {
    hostId: "host-1",
    lifecycle: "live",
    inventoryReady: true,
    items: [],
    errorMessage: null,
    retry: vi.fn(),
    openTab: forwardOpenTab,
    closeTab: forwardCloseTab,
  },
}));

const chatsState = vi.hoisted(() => ({
  value: [
    { id: "chat-driver", title: "Checkout agent" },
    { id: "chat-other", title: "Other chat" },
  ],
}));

vi.mock("@/components/epic-canvas/renderers/browser-sessions-context", () => ({
  useBrowserSessionsContext: () => sessionsState.value,
}));

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
  return {
    originTier: "dev",
    status: "ready",
    title: null,
    viewed: false,
    drivenBy: [],
    ...overrides,
  };
}

function session(
  overrides: Partial<BrowserSessionInfo> &
    Pick<BrowserSessionInfo, "sessionId" | "profile" | "tabs">,
): BrowserSessionInfo {
  return {
    epicId: "epic-1",
    hostId: "host-1",
    lastActivityAt: 2,
    ...overrides,
    runtime: overrides.runtime ?? { kind: "electron", revision: 0 },
  };
}

function wrapper(node: ReactNode): ReactNode {
  return <TooltipProvider delayDuration={0}>{node}</TooltipProvider>;
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
  });
}

describe("BrowsersPanelBody", () => {
  beforeEach(() => {
    dndState.draggables = [];
    browserHostPinState.selection = null;
    browserHostPinState.setSelection.mockClear();
    browserHostProviderState.hostIds = [];
    browserHostOptionsState.hosts = [
      { hostId: "host-1", name: "Home Mac", connectable: true },
      { hostId: "host-2", name: "Work Mac", connectable: true },
    ];
    browserHostOptionsState.isLoading = false;
    browserHostOptionsState.listsFailed = false;
    browserHostOptionsState.retryLists.mockClear();
    closeTab.mockReset();
    closeTab.mockResolvedValue(undefined);
    openTab.mockReset();
    openTab.mockResolvedValue({
      sessionId: "sess-created",
      tabId: "tab-created",
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
    seedCanvasTab();
    sessionsState.value = {
      hostId: "host-1",
      lifecycle: "live",
      inventoryReady: true,
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
      errorMessage: null,
      retry: vi.fn(),
      openTab: forwardOpenTab,
      closeTab: forwardCloseTab,
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
    expect(isoRow.innerHTML).toContain("ring-amber-500/80");
  });

  it("keeps existing row order stable and appends newly discovered tabs", () => {
    const view = render(
      wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />),
    );
    const rowIds = (): string[] =>
      [...screen.getByTestId("epic-browsers-panel-list").children].map(
        (row) => row.firstElementChild?.getAttribute("data-testid") ?? "",
      );
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
      String(entry.id).includes("browser-tile:sess-primary:tab-live"),
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

  it("switches only the panel subscription when its host filter is pinned", () => {
    browserHostPinState.selection = "host-2";

    render(wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />));

    expect(browserHostProviderState.hostIds).toContain("host-2");
  });

  it("filters the flat list by title, hostname, or URL", () => {
    usePanelHeaderSearchStore
      .getState()
      .openSearch("view-tab-1", "browsers", "checkout.example");

    render(wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />));

    expect(screen.getByText("Checkout")).toBeTruthy();
    expect(screen.queryByText("Live page")).toBeNull();
    expect(screen.queryByText("Dormant page")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("1 browser result.");
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

  it("keeps duplicate close names disambiguated while pending", () => {
    closeTab.mockImplementation(() => new Promise<void>(() => undefined));
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

    expect(
      screen
        .getAllByRole("button", { name: /^Closing JioHotstar/ })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "Closing JioHotstar (www.hotstar.com (aaaa))",
      "Closing JioHotstar (www.hotstar.com (bbbb))",
    ]);
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

  it("shows a retryable unavailable state instead of an empty list", () => {
    const retry = vi.fn();
    sessionsState.value = {
      ...sessionsState.value,
      lifecycle: "failed",
      items: [],
      errorMessage: "Host connection failed.",
      retry,
    };

    render(wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />));

    expect(screen.getByText("Browsers unavailable.")).toBeTruthy();
    expect(screen.queryByText("No browsers yet.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
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
    expect(closeTab).toHaveBeenCalledWith("sess-primary", "tab-live");
    await waitFor(() => {
      expect(findOpenArtifactInTab("view-tab-1", pointer.id)).toBeNull();
    });
  });

  it("row click opens a browser-session pointer tile when none is open", () => {
    render(wrapper(<BrowsersPanelBody epicId="epic-1" tabId="view-tab-1" />));

    fireEvent.click(screen.getByRole("button", { name: /^Live page/i }));

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

    expect(screen.getByTestId("epic-browsers-panel-empty")).toBeTruthy();
    expect(screen.getByText("No browsers yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add browser" })).toBeTruthy();
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
    closeTab.mockImplementation(
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

    fireEvent.click(screen.getByRole("button", { name: "Close Live page" }));
    vi.useRealTimers();
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
});

describe("BrowsersPanelActions", () => {
  beforeEach(() => {
    navigateNested.mockClear();
    openTab.mockReset();
    openTab.mockResolvedValue({
      sessionId: "sess-created",
      tabId: "tab-created",
    });
    browserHostPinState.selection = null;
    browserHostPinState.setSelection.mockClear();
    browserHostOptionsState.hosts = [
      { hostId: "host-1", name: "Home Mac", connectable: true },
      { hostId: "host-2", name: "Work Mac", connectable: true },
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
      items: [],
      errorMessage: null,
      retry: vi.fn(),
      openTab: forwardOpenTab,
      closeTab: forwardCloseTab,
    };
  });

  afterEach(() => {
    cleanup();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("opens a new browser through the host and places its session pointer", async () => {
    render(
      wrapper(<BrowsersPanelActions epicId="epic-1" tabId="view-tab-1" />),
    );

    fireEvent.click(screen.getByRole("button", { name: "Add browser" }));

    expect(openTab).toHaveBeenCalledWith(null, "about:blank");
    await waitFor(() => {
      expect(navigateNested).toHaveBeenCalledWith(
        "epic-1",
        "view-tab-1",
        expect.any(Function),
      );
    });
    const opened = Object.values(
      useEpicCanvasStore.getState().canvasByTabId["view-tab-1"]
        ?.tilesByInstanceId ?? {},
    ).find((tile) => tile !== undefined && tile.type === "browser-session");
    expect(opened).toMatchObject({
      hostId: "host-1",
      sessionId: "sess-created",
      tabId: "tab-created",
    });
  });

  it("opens a new browser on the panel's filtered host", async () => {
    browserHostPinState.selection = "host-2";
    sessionsState.value = { ...sessionsState.value, hostId: "host-2" };
    render(
      wrapper(<BrowsersPanelActions epicId="epic-1" tabId="view-tab-1" />),
    );

    fireEvent.click(screen.getByRole("button", { name: "Add browser" }));

    expect(openTab).toHaveBeenCalledWith(null, "about:blank");
    await waitFor(() => {
      expect(navigateNested).toHaveBeenCalledOnce();
    });
    const opened = Object.values(
      useEpicCanvasStore.getState().canvasByTabId["view-tab-1"]
        ?.tilesByInstanceId ?? {},
    ).find((tile) => tile !== undefined && tile.type === "browser-session");
    expect(opened).toMatchObject({ hostId: "host-2" });
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

  it("opens the host filter as the final header action", async () => {
    const user = userEvent.setup();
    render(
      wrapper(<BrowsersPanelActions epicId="epic-1" tabId="view-tab-1" />),
    );

    await user.click(
      screen.getByRole("button", { name: "Filter browsers by host" }),
    );

    const filterMenu = screen.getByTestId("epic-browsers-panel-filter-menu");
    expect(filterMenu.getAttribute("data-side")).toBe("right");
    await user.click(screen.getByRole("menuitem", { name: "Host, Home Mac" }));
    const hostMenu = screen.getByTestId("epic-browsers-panel-host-menu");
    expect(hostMenu.getAttribute("data-side")).toBe("right");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Work Mac" }));
    expect(browserHostPinState.setSelection).toHaveBeenCalledWith("host-2");
  });

  it("shows and clears an active host filter", async () => {
    const user = userEvent.setup();
    browserHostPinState.selection = "host-2";
    render(
      wrapper(<BrowsersPanelActions epicId="epic-1" tabId="view-tab-1" />),
    );

    await user.click(
      screen.getByRole("button", {
        name: "Filter browsers by host, 1 filter active",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Host, Work Mac" }));
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: /Follow active host/ }),
    );

    expect(browserHostPinState.setSelection).toHaveBeenCalledWith(null);
  });

  it("loads host choices progressively in the right-side submenu", async () => {
    const user = userEvent.setup();
    browserHostOptionsState.hosts = [];
    browserHostOptionsState.isLoading = true;
    render(
      wrapper(<BrowsersPanelActions epicId="epic-1" tabId="view-tab-1" />),
    );

    await user.click(
      screen.getByRole("button", { name: "Filter browsers by host" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Host, Home Mac" }));

    expect(screen.getByText("Loading hosts…")).toBeTruthy();
  });
});
