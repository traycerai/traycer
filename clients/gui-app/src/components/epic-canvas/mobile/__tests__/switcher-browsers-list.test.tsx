import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  BrowserSessionInfo,
  BrowserTabInfo,
} from "@traycer/protocol/host/browser/contracts";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SwitcherBrowsersList } from "@/components/epic-canvas/mobile/switcher-browsers-list";
import type { BrowserSessionsState } from "@/components/epic-canvas/renderers/browser-sessions-context";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { BROWSER_TAB_AGENT_ACTIVITY_MS } from "@/lib/browser-view/browser-tab-display";
import {
  fakePrepareOpenTab,
  sessionInfo,
  tabInfo,
} from "@/lib/browser-view/sessions/__tests__/browser-session-test-kit";
import { toast } from "sonner";
import { BrowserCatalogContext } from "@/components/epic-canvas/renderers/browser-catalog-context";
import { useBrowserPanelStore } from "@/stores/epics/browser-panel-store";
import type { BrowserCatalogRecord } from "@traycer/protocol/host/browser/catalog-contracts";

const browserHostPinState = vi.hoisted(() => ({
  selection: null as string | null,
  setSelection: vi.fn(),
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

const hostListState = vi.hoisted(() => ({
  hosts: [] as Array<{
    hostId: string;
    name: string;
    connectable: boolean;
    sandbox: null;
    entry: null;
    item: null;
    health: { state: string };
  }>,
}));

function hostOption(hostId: string, name: string, state: string) {
  return {
    hostId,
    name,
    connectable: true,
    sandbox: null,
    entry: null,
    item: null,
    health: { state },
  };
}

vi.mock("@/components/settings/host-scope/use-host-options", () => ({
  useHostOptions: () => ({
    hosts: hostListState.hosts,
    activeHostId: "host-1",
    isLoading: false,
    listsResolved: true,
    listsFailed: false,
    retryLists: vi.fn(),
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
  BrowserSessionsHostBoundary: (props: { readonly children: ReactNode }) =>
    props.children,
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => undefined,
    isDragging: false,
  }),
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

const sessionsState = vi.hoisted<{ value: BrowserSessionsState }>(() => ({
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
    attachTab: vi.fn(() => Promise.reject(new Error("not used"))),
    moveTab: vi.fn(() => Promise.reject(new Error("not used"))),
  },
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
  useEpicChatRecords: () => [{ id: "chat-driver", title: "Checkout agent" }],
}));

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => navigateNested,
}));

const TAB_ID = "view-tab-1";

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
    runtime: { kind: "headless", revision: 0 },
    ...overrides,
  });
}

function replaceSessions(
  items: readonly BrowserSessionInfo[],
  lifecycle: BrowserSessionsState["lifecycle"],
): void {
  sessionsState.value = { ...sessionsState.value, items, lifecycle };
}

function seedCanvasTab(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useEpicCanvasStore.setState({
    tabsById: {
      [TAB_ID]: { tabId: TAB_ID, epicId: "epic-1", name: "Epic 1" },
    },
    // A pending tab open is only counted "present" while its view tab is in
    // `openTabOrder` (see `preparePendingBrowserTile`'s observer) - a tab
    // registered only in `tabsById` reads as never opened and the pending
    // tile is dismissed the instant it is created.
    openTabOrder: [TAB_ID],
  });
}

// The close action is a TanStack mutation, so these renders need a client.
// ONE for the file's lifetime: a fresh client per render would leave existing
// observers attached to the old one.
const testQueryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, gcTime: 0 },
    mutations: { retry: false },
  },
});

function renderList(onClose: () => void) {
  return render(
    <QueryClientProvider client={testQueryClient}>
      <TooltipProvider delayDuration={0}>
        <SwitcherBrowsersList
          epicId="epic-1"
          tabId={TAB_ID}
          onClose={onClose}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function renderErrorList(onClose: () => void, refetch: () => void) {
  return render(
    <QueryClientProvider client={testQueryClient}>
      <TooltipProvider delayDuration={0}>
        <BrowserCatalogContext.Provider
          value={{ status: "error", scope: "cloud", records: [], refetch }}
        >
          <SwitcherBrowsersList
            epicId="epic-1"
            tabId={TAB_ID}
            onClose={onClose}
          />
        </BrowserCatalogContext.Provider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** The header "+" opens the device picker; the choice is what creates. */
async function addBrowserOnHome(user: UserEvent): Promise<void> {
  await user.click(screen.getAllByRole("button", { name: "Add browser" })[0]);
  await user.click(await screen.findByRole("menuitem", { name: /Home Mac/ }));
}

function openTiles(): ReadonlyArray<{ readonly type: string }> {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[TAB_ID];
  if (canvas === undefined) return [];
  return Object.values(canvas.tilesByInstanceId).flatMap((tile) =>
    tile === undefined ? [] : [tile],
  );
}

describe("SwitcherBrowsersList", () => {
  beforeEach(() => {
    hostListState.hosts = [hostOption("host-1", "Home Mac", "online")];
    seedCanvasTab();
    browserHostPinState.selection = null;
    closeTab.mockReset();
    openTab.mockReset();
    navigateNested.mockClear();
    catalogActions.closeTab.mockReset();
    catalogActions.closeTab.mockResolvedValue(undefined);
    catalogActions.withOwner.mockReset();
    catalogActions.withOwner.mockImplementation(
      (hostId: string, run: (state: BrowserSessionsState) => Promise<void>) =>
        run({ ...sessionsState.value, hostId }),
    );
    vi.mocked(toast.error).mockClear();
    sessionsState.value = {
      ...sessionsState.value,
      prepareOpenTab: fakePrepareOpenTab({
        hostId: () => sessionsState.value.hostId ?? "host-1",
        openTab: forwardOpenTab,
      }),
    };
    replaceSessions(
      [
        session({
          sessionId: "sess-1",
          profile: "primary",
          tabs: [
            tab({
              tabId: "tab-1",
              url: "https://shop.example/cart",
              title: "Cart",
            }),
            tab({
              tabId: "tab-2",
              url: "https://docs.example/guide",
              title: "Guide",
              status: "dormant",
            }),
          ],
        }),
      ],
      "live",
    );
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    // The double-tap test leaves a mutation deliberately unsettled, and the
    // client is shared for the file's lifetime - so without this the pending
    // count stays above zero and every later test finds the add button
    // disabled.
    testQueryClient.getMutationCache().clear();
  });

  it("lists every tab of every session on the surface's host", () => {
    renderList(() => undefined);
    expect(screen.getByRole("button", { name: /^Cart/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Guide/ })).toBeTruthy();
  });

  it("shows the URL on the row, where desktop only has a hover tooltip", () => {
    renderList(() => undefined);
    expect(screen.getByText("https://shop.example/cart")).toBeTruthy();
  });

  it("opens a tapped tab as the shown tile and closes the sheet", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderList(onClose);

    await user.click(screen.getByRole("button", { name: /^Cart/ }));

    expect(navigateNested).toHaveBeenCalled();
    expect(openTiles()).toMatchObject([
      { type: "browser-session", sessionId: "sess-1", tabId: "tab-1" },
    ]);
    expect(onClose).toHaveBeenCalled();
  });

  it("replaces the shown tile rather than stacking one per tap", async () => {
    const user = userEvent.setup();
    renderList(() => undefined);

    await user.click(screen.getByRole("button", { name: /^Cart/ }));
    await user.click(screen.getByRole("button", { name: /^Guide/ }));

    // A phone shows one tile; a second permanent tile would be unreachable.
    expect(openTiles()).toHaveLength(1);
    expect(openTiles()).toMatchObject([{ tabId: "tab-2" }]);
  });

  it("narrows the list by title or URL", async () => {
    const user = userEvent.setup();
    renderList(() => undefined);

    await user.type(screen.getByLabelText("Search browsers"), "docs.example");

    expect(screen.queryByRole("button", { name: /^Cart/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Guide/ })).toBeTruthy();
  });

  it("offers Add browser on a list that already has rows, and closes on the tile", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    openTab.mockResolvedValue({
      sessionId: "sess-2",
      tabId: "tab-9",
      handoffToken: null,
    });
    renderList(onClose);

    await addBrowserOnHome(user);

    await waitFor(() => {
      expect(openTab).toHaveBeenCalledWith(null, "about:blank");
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    // The host's answer rebinds the one pending tile rather than opening a
    // second: a single tile, now pointing at the real tab.
    await waitFor(() => {
      expect(openTiles()).toMatchObject([
        { type: "browser-session", sessionId: "sess-2", tabId: "tab-9" },
      ]);
    });
  });

  it("highlights the rebound row by host/session/tab once a pending add resolves onto it, even though the active tile's node id stays the pending one", async () => {
    const onClose = vi.fn();
    openTab.mockResolvedValue({
      sessionId: "sess-1",
      tabId: "tab-1",
      handoffToken: null,
    });
    // The same session/tab on another host must stay inactive.
    replaceSessions(
      [
        ...sessionsState.value.items,
        session({
          sessionId: "sess-1",
          hostId: "host-2",
          profile: "primary",
          tabs: [
            tab({
              tabId: "tab-1",
              url: "https://shop.example/cart",
              title: "Other host cart",
            }),
          ],
        }),
      ],
      "live",
    );
    renderList(onClose);

    const cartRow = screen.getByRole("button", { name: /^Cart/ });
    const otherHostRow = screen.getByRole("button", {
      name: /^Other host cart/,
    });
    expect(cartRow.getAttribute("aria-current")).toBeNull();
    expect(otherHostRow.getAttribute("aria-current")).toBeNull();

    await addBrowserOnHome(userEvent.setup());

    await waitFor(() => {
      expect(openTab).toHaveBeenCalledWith(null, "about:blank");
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(openTiles()).toHaveLength(1);
    await waitFor(() => {
      expect(
        screen
          .getByRole("button", { name: /^Cart/ })
          .getAttribute("aria-current"),
      ).toBe("true");
    });
    expect(
      screen
        .getByRole("button", { name: /^Other host cart/ })
        .getAttribute("aria-current"),
    ).toBeNull();
    expect(
      screen
        .getByRole("button", { name: /^Guide/ })
        .getAttribute("aria-current"),
    ).toBeNull();
  });

  it("opens one browser for two taps while the host is still answering", async () => {
    const user = userEvent.setup();
    // A request that never settles is the whole of the window this guards: on a
    // phone the host round-trip is long enough to be tapped through, and two
    // answers would mean two tabs and two tiles with nothing downstream to
    // collapse them.
    openTab.mockImplementation(() => new Promise(() => undefined));
    renderList(() => undefined);
    const add = screen.getByRole<HTMLButtonElement>("button", {
      name: "Add browser",
    });

    await addBrowserOnHome(user);
    await waitFor(() => {
      expect(add.disabled).toBe(true);
    });
    await user.click(add);

    expect(openTab).toHaveBeenCalledTimes(1);
  });

  it("keeps the sheet open when a browser cannot be created", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    catalogActions.withOwner.mockRejectedValue(
      new Error("Couldn't connect to this device. Try again."),
    );
    renderErrorList(onClose, vi.fn());

    await addBrowserOnHome(user);

    // Nothing opened, so there is nothing for the sheet to get out of the way
    // of - and leaving would take this state's Retry with it.
    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalled();
    });
    expect(openTab).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("the sheet is already dismissed once when the host refuses the new tab", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    openTab.mockRejectedValue(new Error("no runtime"));
    renderList(onClose);

    await addBrowserOnHome(user);

    // `onClose` (the picker's `onOpened`) fires with the pending tile, before
    // the host has answered at all - so a refusal arriving later does not get
    // a second dismiss, and the sheet does not reopen for it either.
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce();
    });

    await waitFor(() => {
      expect(openTab).toHaveBeenCalled();
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes a tab from the row's own action", async () => {
    const user = userEvent.setup();
    renderList(() => undefined);

    await user.click(screen.getByRole("button", { name: "Close Cart" }));

    await waitFor(() => {
      expect(catalogActions.closeTab).toHaveBeenCalledWith(
        { epicId: "epic-1", hostId: "host-1", sessionId: "sess-1" },
        "tab-1",
      );
    });
  });

  it("offers the driving chat as a tappable action, not a hover glyph", () => {
    replaceSessions(
      [
        session({
          sessionId: "sess-1",
          profile: "primary",
          tabs: [
            tab({
              tabId: "tab-1",
              url: "https://shop.example/cart",
              title: "Cart",
              drivenBy: [
                {
                  chatId: "chat-driver",
                  agentRunId: null,
                  requestId: "req-1",
                },
              ],
            }),
          ],
        }),
      ],
      "live",
    );
    vi.useFakeTimers();
    renderList(() => undefined);
    // The glyph is coalesced in both directions, so it only exists once the
    // same chat is still driving after the delay.
    act(() => {
      vi.advanceTimersByTime(BROWSER_TAB_AGENT_ACTIVITY_MS);
    });
    vi.useRealTimers();

    fireEvent.click(
      screen.getByRole("button", { name: "Open driving chat: Checkout agent" }),
    );

    expect(openTiles()).toMatchObject([{ type: "chat", id: "chat-driver" }]);
  });

  it("mounts the desktop empty state, add affordance included", () => {
    replaceSessions([], "live");
    renderList(() => undefined);
    const empty = screen.getByTestId("browser-list-empty-state");
    expect(empty).toBeTruthy();
    // The shared component's plain headline: this task has no browsers this
    // window can see anywhere, so "yet" is the honest word. The other-machine
    // headline is pinned where the component is defined.
    expect(screen.getByText("No browsers yet.")).toBeTruthy();
    // On an empty list the header "+" and this labelled button are BOTH on
    // screen and share an accessible name, which device verification caught as
    // a two-match query waiting to happen. Pinned here so the ambiguity is a
    // stated fact rather than a trap for the next name-only query.
    expect(screen.getAllByRole("button", { name: "Add browser" })).toHaveLength(
      2,
    );
    expect(
      within(empty).getByRole("button", { name: "Add browser" }),
    ).toBeTruthy();
  });

  it("keeps the rows reachable and offers Retry when the catalog fails to load", () => {
    const refetch = vi.fn();
    renderErrorList(() => undefined, refetch);

    expect(screen.getByText("Couldn't load browser tabs.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Cart/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Guide/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledOnce();
  });
});

describe("SwitcherBrowsersList over the task-wide catalog", () => {
  function record(
    hostId: string,
    sessionId: string,
    tabId: string,
    title: string,
  ): BrowserCatalogRecord {
    return {
      epicId: "epic-1",
      hostId,
      sessionId,
      inventoryRevision: 1,
      lastActivityAt: 1,
      tabs: [{ tabId, title, url: `https://${tabId}.example` }],
    };
  }

  function renderCatalog() {
    const records = [
      record("host-1", "s1", "t1", "Docs"),
      record("host-2", "s2", "t2", "Docs"),
      record("host-3", "s3", "t3", "Router"),
    ];
    return render(
      <QueryClientProvider client={testQueryClient}>
        <TooltipProvider delayDuration={0}>
          <BrowserCatalogContext.Provider
            value={{
              status: "ready",
              scope: "cloud",
              records,
              refetch: vi.fn(),
            }}
          >
            <SwitcherBrowsersList
              epicId="epic-1"
              tabId={TAB_ID}
              onClose={() => undefined}
            />
          </BrowserCatalogContext.Provider>
        </TooltipProvider>
      </QueryClientProvider>,
    );
  }

  beforeEach(() => {
    window.localStorage.clear();
    useBrowserPanelStore.setState({ preferences: {} });
    seedCanvasTab();
    catalogActions.closeTab.mockReset();
    catalogActions.closeTab.mockResolvedValue(undefined);
    closeTab.mockReset();
    replaceSessions([], "connecting");
    sessionsState.value = {
      ...sessionsState.value,
      inventoryReady: false,
    };
  });

  afterEach(cleanup);

  it("groups tabs by device with the same offline default as the desktop list", () => {
    hostListState.hosts = [
      hostOption("host-1", "Home Mac", "online"),
      hostOption("host-2", "Work Mac", "unknown"),
      hostOption("host-3", "NAS", "offline"),
    ];
    renderCatalog();

    expect(
      screen.getByTestId("browser-device-group-host-1").textContent,
    ).toContain("Local");
    expect(
      screen.getByTestId("browser-device-group-host-2").textContent,
    ).toContain("Work Mac");
    expect(screen.queryByTestId("browser-device-group-host-3")).toBeNull();
    expect(screen.getAllByText("Docs")).toHaveLength(2);
  });

  it("shows offline devices once the shared filter is switched on", async () => {
    const user = userEvent.setup();
    hostListState.hosts = [
      hostOption("host-1", "Home Mac", "online"),
      hostOption("host-2", "Work Mac", "online"),
      hostOption("host-3", "NAS", "offline"),
    ];
    renderCatalog();

    await user.click(screen.getByTestId("switcher-browsers-filter"));
    await user.click(
      await screen.findByRole("menuitemcheckbox", {
        name: "Show offline devices",
      }),
    );

    expect(
      screen.getByTestId("browser-device-group-host-3").textContent,
    ).toContain("Offline");
  });

  it("closes a tab through its owning device", async () => {
    const user = userEvent.setup();
    hostListState.hosts = [
      hostOption("host-1", "Home Mac", "online"),
      hostOption("host-2", "Work Mac", "online"),
    ];
    renderCatalog();

    await user.click(screen.getAllByRole("button", { name: /^Close Docs/ })[1]);

    await waitFor(() => {
      expect(catalogActions.closeTab).toHaveBeenCalledWith(
        { epicId: "epic-1", hostId: "host-2", sessionId: "s2" },
        "t2",
      );
    });
    expect(closeTab).not.toHaveBeenCalled();
  });
});
